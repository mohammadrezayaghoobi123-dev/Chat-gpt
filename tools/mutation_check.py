"""Tiny AST mutation tester (free, dependency-free) used to verify Master Brain fixes.

Usage (from the repository root):

    MUT_LINES="10-40,55-60" PYTHONPATH=src python3 tools/mutation_check.py . \
        src/master_brain/audit_policy.py tests.test_audit_policy tests.test_audit_store

Arguments: <repo_root> <source_file_relative_to_root> <unittest modules...>.
MUT_LINES (optional) restricts mutants to those line ranges, e.g. the lines a fix changed.
Each mutant (comparison/bool/int flips, raise/return removal, tuple-element drops,
regex-quantifier shifts, call removal) is applied to a temporary copy of the repo and the
named test modules run; a mutant is KILLED if any test fails, SURVIVED if all pass.
Surviving mutants are test gaps unless they are equivalent (behaviour-preserving).
Exit status is non-zero if any mutant survived. Original sources are never modified.
"""
import ast, copy, os, re, shutil, subprocess, sys, tempfile, json
from concurrent.futures import ThreadPoolExecutor

args = sys.argv[1:]
ranges = []
if args and args[0].startswith("--lines="):
    ranges = [tuple(map(int, r.split("-"))) for r in args.pop(0)[8:].split(",")]
repo, rel, *tests = args
src_path = os.path.join(repo, rel)
source = open(src_path).read()
tree0 = ast.parse(source)

CMP = {ast.Eq: ast.NotEq, ast.NotEq: ast.Eq, ast.Lt: ast.GtE, ast.GtE: ast.Lt,
       ast.Gt: ast.LtE, ast.LtE: ast.Gt, ast.In: ast.NotIn, ast.NotIn: ast.In,
       ast.Is: ast.IsNot, ast.IsNot: ast.Is}

def _annotation_ids(tree):
    ids = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.AnnAssign):
            ids.update(id(x) for x in ast.walk(n.annotation))
        if isinstance(n, ast.arg) and n.annotation is not None:
            ids.update(id(x) for x in ast.walk(n.annotation))
        if isinstance(n, ast.FunctionDef) and n.returns is not None:
            ids.update(id(x) for x in ast.walk(n.returns))
    return ids

def _line_filter():
    spec = os.environ.get("MUT_LINES", "")
    ranges = [tuple(int(x) for x in part.split("-")) for part in spec.split(",") if part]
    return (lambda ln: any(a <= ln <= b for a, b in ranges)) if ranges else (lambda ln: True)
_in_scope = _line_filter()

def targets(tree):
    skip = _annotation_ids(tree)
    """Yield (description, mutate_fn(tree_copy)->None) by node index in ast.walk order."""
    out = []
    for idx, node in enumerate(ast.walk(tree)):
        if id(node) in skip or not _in_scope(getattr(node, "lineno", 0)):
            continue
        line = getattr(node, "lineno", 0)
        if ranges and not any(a <= line <= b for a, b in ranges):
            continue
        if isinstance(node, ast.Compare):
            for k, op in enumerate(node.ops):
                if type(op) in CMP:
                    out.append((idx, f"L{line} cmp {type(op).__name__}->{CMP[type(op)].__name__}", ("cmp", k)))
        elif isinstance(node, ast.BoolOp):
            out.append((idx, f"L{line} boolop {type(node.op).__name__} swap", ("bool", 0)))
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            out.append((idx, f"L{line} drop 'not'", ("not", 0)))
        elif isinstance(node, ast.Constant) and isinstance(node.value, bool):
            out.append((idx, f"L{line} bool {node.value}->{not node.value}", ("boolc", 0)))
        elif isinstance(node, ast.Constant) and isinstance(node.value, int) and not isinstance(node.value, bool):
            out.append((idx, f"L{line} int {node.value}->{node.value+1}", ("int+", 0)))
            out.append((idx, f"L{line} int {node.value}->{node.value-1}", ("int-", 0)))
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and re.search(r"\{\d+,\}", node.value):
            for m in re.finditer(r"\{(\d+),\}", node.value):
                out.append((idx, f"L{line} regex {m.group(0)} boundary +1 @{m.start()}", ("rx+", m.start())))
                out.append((idx, f"L{line} regex {m.group(0)} boundary -1 @{m.start()}", ("rx-", m.start())))
        elif isinstance(node, ast.Raise):
            out.append((idx, f"L{line} raise->pass", ("raise", 0)))
        elif isinstance(node, ast.Return) and node.value is not None:
            out.append((idx, f"L{line} return->return None", ("ret", 0)))
        elif isinstance(node, (ast.Tuple, ast.Set)) and len(getattr(node, "elts", [])) > 1:
            for k in range(len(node.elts)):
                out.append((idx, f"L{line} drop element #{k}", ("drop", k)))
        elif isinstance(node, ast.Call) and getattr(node.func, "id", "") in ("enforce_payload_policy", "_check_text", "_walk"):
            out.append((idx, f"L{line} remove call {node.func.id}", ("call", 0)))
    return out

def apply(tree, idx, kind):
    nodes = list(ast.walk(tree))
    node = nodes[idx]
    k, arg = kind
    parent = None
    if k == "cmp":
        node.ops[arg] = CMP[type(node.ops[arg])]()
    elif k == "bool":
        node.op = ast.Or() if isinstance(node.op, ast.And) else ast.And()
    elif k == "not":
        for p in nodes:
            for f, v in ast.iter_fields(p):
                if v is node: setattr(p, f, node.operand)
                elif isinstance(v, list):
                    for i, e in enumerate(v):
                        if e is node: v[i] = node.operand
    elif k == "boolc": node.value = not node.value
    elif k == "int+": node.value += 1
    elif k == "int-": node.value -= 1
    elif k in ("rx+", "rx-"):
        s = node.value; m = re.compile(r"\{(\d+),\}").match(s, arg)
        n = int(m.group(1)) + (1 if k == "rx+" else -1)
        node.value = s[:m.start(1)] + str(n) + s[m.end(1):]
    elif k in ("raise", "ret", "call"):
        repl = ast.Pass() if k != "ret" else ast.Return(value=ast.Constant(None))
        if k == "call":  # call as Expr statement or inside expression
            for p in nodes:
                for f, v in ast.iter_fields(p):
                    if isinstance(v, list):
                        for i, e in enumerate(v):
                            if isinstance(e, ast.Expr) and e.value is node: v[i] = ast.Pass()
            return
        for p in nodes:
            for f, v in ast.iter_fields(p):
                if isinstance(v, list):
                    for i, e in enumerate(v):
                        if e is node: v[i] = repl
    elif k == "drop":
        del node.elts[arg]
    ast.fix_missing_locations(tree)

def run(job):
    idx, desc, kind = job
    tree = copy.deepcopy(tree0)
    apply(tree, idx, kind)
    mutated = ast.unparse(tree)
    if mutated == ast.unparse(tree0):
        return (desc, "EQUIVALENT-UNCHANGED")
    work = tempfile.mkdtemp()
    try:
        shutil.copytree(os.path.join(repo, "src"), os.path.join(work, "src"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(os.path.join(repo, "tests"), os.path.join(work, "tests"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        open(os.path.join(work, rel), "w").write(mutated)
        env = {**os.environ, "PYTHONPATH": os.path.join(work, "src") + os.pathsep + work,
               "PYTHONDONTWRITEBYTECODE": "1"}
        try:
            p = subprocess.run([sys.executable, "-m", "unittest", "-f", *tests], cwd=work, env=env,
                               capture_output=True, text=True, timeout=180)
            if p.returncode == 0:
                return (desc, "SURVIVED")
            m = re.search(r"^(?:FAIL|ERROR): (\S+)", p.stderr, re.M)
            return (desc, "killed:" + (m.group(1) if m else "?"))
        except subprocess.TimeoutExpired:
            return (desc, "killed(timeout)")
    finally:
        shutil.rmtree(work, ignore_errors=True)

jobs = [(i, d, k) for i, d, k in targets(tree0)]
print(f"{len(jobs)} mutants on {rel}", flush=True)
with ThreadPoolExecutor(max_workers=2) as ex:
    results = list(ex.map(run, jobs))
survived = [d for d, s in results if s == "SURVIVED"]
unchanged = [d for d, s in results if s == "EQUIVALENT-UNCHANGED"]
killed = sum(1 for _, s in results if s.startswith("killed"))
print(json.dumps({"total": len(results), "killed": killed, "survived": len(survived), "unchanged": len(unchanged)}))
for d in survived: print("SURVIVED:", d)
from collections import Counter
print("KILLERS:", dict(Counter(st.split(":",1)[1] for _, st in results if st.startswith("killed:")).most_common(8)))
for d in unchanged: print("UNCHANGED:", d)
sys.exit(1 if survived else 0)
