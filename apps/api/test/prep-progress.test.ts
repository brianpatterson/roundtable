// Prep progress (GLOSSARY.md), at the contract's interface: the web's Round and the Agenda both
// take it from `prepProgress`. Pure, so no database here. (The contract has no test runner of its
// own; its pure rules are tested here, like Round order.)
import { describe, expect, it } from 'vitest';
import { prepProgress, type PrepTask } from '@roundtable/contract';

const task = (title: string, completedAt: Date | null = null): PrepTask => ({
  id: title,
  title,
  skillId: null,
  completedAt,
});

const DONE = new Date('2026-11-24T10:00:00Z');

describe('prepProgress', () => {
  it('is null for a Round without prep tasks', () => {
    expect(prepProgress({ prepTasks: [] })).toBeNull();
  });

  it('counts none done of a Round’s tasks', () => {
    expect(prepProgress({ prepTasks: [task('a'), task('b')] })).toEqual({ done: 0, total: 2 });
  });

  it('counts the tasks with a completion date as done', () => {
    const prepTasks = [task('a', DONE), task('b'), task('c', DONE)];

    expect(prepProgress({ prepTasks })).toEqual({ done: 2, total: 3 });
  });

  it('counts every task done when all are', () => {
    expect(prepProgress({ prepTasks: [task('a', DONE)] })).toEqual({ done: 1, total: 1 });
  });
});
