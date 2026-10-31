import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask } from '../master_brain/core/task.mjs';

test('creates a normalized Task from a user goal', () => {
  const task = createTask({
    objective: 'برای کارخانه EVA یک خط تولید حرفه‌ای با ظرفیت 1 تن در روز پیدا کن',
    constraints: ['غیرپیوسته', 'کیفیت حرفه‌ای'],
    risk: 'medium',
    required_capabilities: ['research', 'manufacturing'],
    success_criteria: ['supplier shortlist', 'capacity verified']
  });

  assert.equal(task.type, 'Task');
  assert.equal(task.objective, 'برای کارخانه EVA یک خط تولید حرفه‌ای با ظرفیت 1 تن در روز پیدا کن');
  assert.deepEqual(task.constraints, ['غیرپیوسته', 'کیفیت حرفه‌ای']);
  assert.equal(task.risk, 'medium');
  assert.deepEqual(task.required_capabilities, ['research', 'manufacturing']);
  assert.deepEqual(task.success_criteria, ['supplier shortlist', 'capacity verified']);
  assert.equal(task.status, 'BACKLOG');
});

test('rejects a Task without an objective', () => {
  assert.throws(() => createTask({}), /objective is required/);
});
