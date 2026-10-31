export async function executeInParallel(tasks = []) {
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');
  return Promise.all(tasks.map(async task => {
    if (!task?.id || typeof task.run !== 'function') throw new TypeError('each task needs id and run');
    try {
      const value = await task.run();
      return { id: task.id, status: 'fulfilled', value };
    } catch (error) {
      return { id: task.id, status: 'rejected', error: error instanceof Error ? error.message : String(error) };
    }
  }));
}
