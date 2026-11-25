"""Read-only fail-closed preflight for EGIS source/JAR JUnit report roots."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import shlex
import stat
from typing import Mapping, Sequence

LOCKED_REPORT_ROOT = PurePosixPath("target/surefire-reports")
LOCKED_CUSTOM_BUILD_BLOB_SHA1 = "3ee52fe5bc36e8e559e6a13f8c967cd8b67f9976"
REQUIRED_PROPERTIES = {
    "maven.test.skip": "false",
    "maven.test.halt": "true",
    "test.halt": "true",
}
FORBIDDEN_PROPERTIES = {"noclean", "test.skip"}
CONTROLLED_PROPERTIES = set(REQUIRED_PROPERTIES) | FORBIDDEN_PROPERTIES | {"basedir", "test.reports"}
ENVIRONMENT_FLAGS = ("ANT_ARGS", "ANT_OPTS", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS")


def _blocked(reason: str, **details: object) -> dict:
    result = {"status": "BLOCKED", "reason": reason}
    if details:
        result["details"] = details
    return result


def _report_value(value: object) -> str | None:
    if not isinstance(value, str) or value != value.strip() or "\\" in value:
        return None
    if value.startswith(("/", "~")) or ":" in value or PureWindowsPath(value).is_absolute():
        return None
    normalized = value[:-1] if value.endswith("/") else value
    if any(part in {"", ".", ".."} for part in normalized.split("/")):
        return None
    return normalized if PurePosixPath(normalized) == LOCKED_REPORT_ROOT else None


def _path_issue(path: Path) -> tuple[str, str] | None:
    """Inspect every existing component without following links/reparse points."""
    absolute = Path(os.path.abspath(os.fspath(path)))
    current = Path(absolute.anchor)
    parts = absolute.parts[1:]
    for index, part in enumerate(parts):
        current /= part
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            continue
        except (OSError, ValueError):
            return "path_inspection_failed", str(current)
        reparse = getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        if stat.S_ISLNK(info.st_mode) or reparse:
            return "symlink_path_component", str(current)
        if index < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
            return "path_ancestor_not_directory", str(current)
    return None


def _launcher_arguments(environment: Mapping[str, str]) -> tuple[list[str], str | None]:
    result: list[str] = []
    for key in ENVIRONMENT_FLAGS:
        value = environment.get(key, "")
        if not isinstance(value, str):
            return [], "ant_environment_argument_invalid"
        try:
            result.extend(shlex.split(value, posix=os.name != "nt"))
        except ValueError:
            return [], "ant_environment_argument_malformed"
    return result, None


def _validate_arguments(arguments: Sequence[str], expected_buildfile: Path) -> tuple[str | None, dict[str, str | None]]:
    overrides: dict[str, str | None] = {}
    buildfiles: list[str] = []
    targets: list[str] = []
    blocked_extensions = {"-lib", "-listener", "-logger", "-inputhandler", "-main", "-autoproxy"}
    jvm_prefixes = (
        "-javaagent", "-agentlib", "-agentpath", "-xrun", "-xbootclasspath",
        "--patch-module", "--upgrade-module-path", "-xplugin", "-djava.system.class.loader=",
        "-djava.class.path=", "-djava.ext.dirs=", "-djava.endorsed.dirs=",
        "-djava.security.manager", "-djava.security.policy=",
    )
    index = 0
    while index < len(arguments):
        arg = arguments[index]
        if not isinstance(arg, str):
            return "ant_argument_not_string", {}
        lowered = arg.lower()
        if lowered.startswith(jvm_prefixes):
            return "jvm_launcher_code_injection_not_allowed", {}
        if arg in blocked_extensions or any(arg.startswith(x + "=") for x in blocked_extensions if x != "-autoproxy"):
            return "ant_extension_or_proxy_injection_not_allowed", {}
        if arg == "-propertyfile" or arg.startswith("-propertyfile="):
            return "external_ant_property_file_not_allowed", {}
        if arg in {"-find", "-s"}:
            return "ant_buildfile_search_not_allowed", {}
        if arg in {"-f", "-file", "-buildfile"}:
            if index + 1 >= len(arguments):
                return "ant_buildfile_argument_missing", {}
            buildfiles.append(arguments[index + 1])
            index += 1
        elif arg.startswith(("-f=", "-file=", "-buildfile=")):
            return "ant_buildfile_argument_format_invalid", {}
        elif arg == "-D":
            return "ant_property_argument_format_invalid", {}
        elif arg.startswith("-D"):
            token = arg[2:]
            name, sep, value = token.partition("=")
            if not name:
                return "ant_property_name_empty", {}
            if name not in CONTROLLED_PROPERTIES:
                return "unreviewed_ant_property_override", {}
            if name in overrides:
                return "controlled_ant_property_duplicated", {}
            if name in FORBIDDEN_PROPERTIES:
                return "forbidden_ant_property_override", {}
            if name == "basedir":
                return "ant_basedir_override_not_allowed", {}
            if name not in REQUIRED_PROPERTIES and name != "test.reports":
                return "unreviewed_ant_property_override", {}
            overrides[name] = value if sep else None
        elif arg.startswith("-"):
            return "ant_argument_not_allowlisted", {}
        else:
            targets.append(arg)
        index += 1
    if len(buildfiles) != 1:
        return "ant_buildfile_not_explicitly_locked", {}
    if targets != ["default"]:
        return "ant_target_not_locked", {}
    try:
        supplied = Path(buildfiles[0])
        if not supplied.is_absolute():
            return "ant_buildfile_mismatch", {}
        expected = os.path.normcase(os.path.abspath(os.fspath(expected_buildfile)))
        actual = os.path.normcase(os.path.abspath(os.fspath(supplied)))
    except (OSError, TypeError, ValueError):
        return "ant_buildfile_argument_invalid", {}
    if expected != actual:
        return "ant_buildfile_mismatch", {}
    return None, overrides


def _home_directories(environment: Mapping[str, str]) -> list[Path] | None:
    candidates: list[str] = []
    for key in ("HOME", "USERPROFILE"):
        value = environment.get(key)
        if value:
            if not isinstance(value, str) or not Path(value).is_absolute():
                return None
            candidates.append(value)
    try:
        candidates.append(str(Path.home()))
    except (OSError, RuntimeError, TypeError, ValueError):
        return None
    unique: dict[str, Path] = {}
    for value in candidates:
        path = Path(os.path.abspath(os.fspath(Path(value).expanduser())))
        unique[os.path.normcase(os.fspath(path))] = path
    return list(unique.values())


def _wrapper_hook_present(environment: Mapping[str, str]) -> bool:
    homes = _home_directories(environment)
    if homes is None:
        return True
    for directory in homes:
        issue = _path_issue(directory)
        if issue:
            return True
        try:
            if any(os.path.lexists(directory / name) for name in (".antrc", "antrc_pre.bat", "antrc_post.bat")):
                return True
        except (OSError, RuntimeError, TypeError, ValueError):
            return True
    return False


def _user_ant_library_present(environment: Mapping[str, str]) -> bool:
    homes = _home_directories(environment)
    if homes is None:
        return True
    for directory in homes:
        library = directory / ".ant" / "lib"
        issue = _path_issue(library)
        if issue:
            return True
        try:
            if not os.path.lexists(library):
                continue
            if not library.is_dir():
                return True
            with os.scandir(library) as entries:
                if next(entries, None) is not None:
                    return True
        except (OSError, RuntimeError, TypeError, ValueError):
            return True
    return False


def _git_blob_sha1(path: Path) -> str:
    content = path.read_bytes()
    header = f"blob {len(content)}\\0".encode("ascii")
    return hashlib.sha1(header + content).hexdigest()


def preflight_report_roots(
    root: Path,
    *,
    ant_properties: Mapping[str, str],
    ant_arguments: Sequence[str] = (),
    environment: Mapping[str, str] | None = None,
) -> dict:
    """Check a caller-supplied effective property snapshot and exact launcher inputs.

    This function is read-only and point-in-time. It is not a concurrency lock
    and does not attest that a later Ant process receives this same snapshot.
    """
    if not isinstance(ant_properties, Mapping):
        return _blocked("effective_ant_properties_invalid")
    if isinstance(ant_arguments, (str, bytes)) or not isinstance(ant_arguments, Sequence):
        return _blocked("ant_arguments_invalid")
    env = os.environ if environment is None else environment
    if not isinstance(env, Mapping):
        return _blocked("ant_environment_invalid")
    classpath = env.get("CLASSPATH", "")
    if not isinstance(classpath, str):
        return _blocked("ant_classpath_environment_invalid")
    if classpath.strip():
        return _blocked("ant_classpath_environment_not_allowed")
    if _user_ant_library_present(env):
        return _blocked("ant_user_library_not_allowed")
    env_args, env_error = _launcher_arguments(env)
    if env_error:
        return _blocked(env_error)
    args = [*env_args, *ant_arguments]
    if _wrapper_hook_present(env):
        return _blocked("external_ant_wrapper_hook_present")

    props = dict(ant_properties)
    for key in FORBIDDEN_PROPERTIES:
        if key in props:
            return _blocked("forbidden_ant_property_present", property=key)
    for key, expected in REQUIRED_PROPERTIES.items():
        if props.get(key) != expected:
            return _blocked("required_ant_property_missing_or_mismatched", property=key)
    if _report_value(props.get("test.reports")) != LOCKED_REPORT_ROOT.as_posix():
        return _blocked("test_reports_property_not_locked")

    root_path = Path(os.path.abspath(os.fspath(Path(root).expanduser())))
    issue = _path_issue(root_path)
    if issue:
        return _blocked(issue[0], path=issue[1])
    try:
        root_real = root_path.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return _blocked("checkout_root_unavailable")
    if root_real != root_path or not root_real.is_dir():
        return _blocked("checkout_root_not_canonical_directory")

    basedir = props.get("basedir")
    if not isinstance(basedir, str) or not Path(basedir).is_absolute():
        return _blocked("effective_basedir_missing_or_not_absolute")
    basedir_path = Path(basedir)
    issue = _path_issue(basedir_path)
    if issue:
        return _blocked(issue[0], path=issue[1])
    try:
        if basedir_path.resolve(strict=True) != root_real or basedir_path != root_real:
            return _blocked("effective_basedir_mismatch")
    except (OSError, RuntimeError, ValueError):
        return _blocked("effective_basedir_unavailable")

    buildfile = root_real / "customBuild.xml"
    issue = _path_issue(buildfile)
    if issue:
        return _blocked(issue[0], path=issue[1])
    if not buildfile.is_file():
        return _blocked("locked_ant_buildfile_missing")
    try:
        buildfile_blob_sha1 = _git_blob_sha1(buildfile)
    except (OSError, RuntimeError, ValueError):
        return _blocked("locked_ant_buildfile_unreadable")
    if buildfile_blob_sha1 != LOCKED_CUSTOM_BUILD_BLOB_SHA1:
        return _blocked("locked_ant_buildfile_digest_mismatch")

    error, overrides = _validate_arguments(args, buildfile)
    if error:
        return _blocked(error)
    for key, value in overrides.items():
        if key in FORBIDDEN_PROPERTIES or value is None:
            return _blocked("forbidden_or_empty_ant_property_override", property=key)
        if key in REQUIRED_PROPERTIES and value != REQUIRED_PROPERTIES[key]:
            return _blocked("ant_required_property_override_mismatch", property=key)
        if key == "test.reports" and _report_value(value) != LOCKED_REPORT_ROOT.as_posix():
            return _blocked("ant_report_root_override_mismatch")

    report_root = root_real.joinpath(*LOCKED_REPORT_ROOT.parts)
    issue = _path_issue(report_root)
    if issue:
        return _blocked(issue[0], path=issue[1])
    if os.path.lexists(report_root):
        return _blocked("report_root_already_exists", path=str(report_root))
    source_root = report_root / "source"
    jar_root = report_root / "onJar"
    source_real = source_root.resolve(strict=False)
    jar_real = jar_root.resolve(strict=False)
    report_real = report_root.resolve(strict=False)
    if not report_real.is_relative_to(root_real):
        return _blocked("report_root_outside_checkout")
    if source_real == jar_real or source_real.is_relative_to(jar_real) or jar_real.is_relative_to(source_real):
        return _blocked("source_and_jar_report_roots_overlap")
    if not source_real.is_relative_to(report_real) or not jar_real.is_relative_to(report_real):
        return _blocked("report_subroot_outside_report_root")

    return {
        "status": "PASS",
        "reason": "fresh_canonical_report_roots_are_disjoint",
        "checkout_root": str(root_real),
        "report_root": str(report_real),
        "source_report_root": str(source_real),
        "packaged_jar_report_root": str(jar_real),
        "ant_properties_verified": sorted(set(REQUIRED_PROPERTIES) | {"basedir", "test.reports"}),
        "ant_buildfile": "customBuild.xml",
        "controlled_launcher_overrides_checked": sorted(overrides),
        "side_effects": "NONE",
        "assurance_scope": "READ_ONLY_POINT_IN_TIME_PREFLIGHT_NOT_A_CONCURRENCY_LOCK",
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--properties-json", type=Path, required=True)
    parser.add_argument("--ant-arg", action="append", default=[])
    args = parser.parse_args(argv)
    try:
        properties = json.loads(args.properties_json.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        result = _blocked("effective_properties_json_unreadable")
    else:
        result = preflight_report_roots(args.root, ant_properties=properties, ant_arguments=args.ant_arg)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
