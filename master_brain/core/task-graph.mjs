const TERMINAL = new Set(['VERIFIED', 'DONE', 'FAILED', 'BLOCKED']);

export function createTaskGraph(definitions = []) {
  const graph = new Map();
  for (const definition of definitions) {
    if (!definition?.id || graph.has(definition.id)) throw new TypeError('task id must be unique');
    graph.set(definition.id, {
      ...definition,
      status: definition.status ?? 'READY',
      depends_on: [...(definition.depends_on ?? [])],
      result: undefined,
      error: undefined,
    });
  }
  for (const task of graph.values()) {
    for (const dep of task.depends_on) {
      if (!graph.has(dep)) throw new TypeError(`unknown dependency: ${dep}`);
    }
  }
  return graph;
}

function dependencyState(task, graph) {
  const deps = task.depends_on.map(id => graph.get(id));
  if (deps.some(dep => dep.status === 'FAILED' || dep.status === 'BLOCKED')) return 'blocked';
  if (deps.every(dep => TERMINAL.has(dep.status) && dep.status !== 'FAILED' && dep.status !== 'BLOCKED')) return 'ready';
  return 'waiting';
}

export async function runReadyTasks(graph, runner) {
  if (!(graph instanceof Map)) throw new TypeError('graph must be a Map');
  if (typeof runner !== 'function') throw new TypeError('runner is required');

  for (const task of graph.values()) {
    if (task.status === 'READY' && dependencyState(task, graph) === 'blocked') task.status = 'BLOCKED';
  }

  const ready = [...graph.values()].filter(task => task.status === 'READY' && dependencyState(task, graph) === 'ready');
  await Promise.all(ready.map(async task => {
    task.status = 'RUNNING';
    try {
      task.result = await runner(task);
      task.status = 'VERIFIED';
    } catch (error) {
      task.error = error instanceof Error ? error.message : String(error);
      task.status = 'FAILED';
    }
  }));

  for (const task of graph.values()) {
    if (task.status === 'READY' && dependencyState(task, graph) === 'blocked') task.status = 'BLOCKED';
  }

  const unfinished = [...graph.values()].some(task => !TERMINAL.has(task.status));
  return { status: unfinished ? 'READY' : 'VERIFIED' };
}
