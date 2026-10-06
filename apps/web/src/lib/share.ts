import type { Mode } from './types';

/** The text a person pastes to an AI agent. Step by step, because agents follow steps. */
export function sharePrompt(o: { origin: string; projectId: string; mode: Mode; password: string }): string {
  return [
    'You have access to an mdh-mdh project: a folder of markdown (.md) and yaml (.yml/.yaml) files.',
    '',
    `Step 1. Read ${o.origin}/llm.txt`,
    'It explains everything this token can do: check your permission level,',
    'read files, edit files, upload files and folders, and use the history.',
    '',
    'Step 2. Start making API requests right away.',
    'The password already identifies the project, so there is nothing else to set up.',
    'Send it with every request as the header:',
    `Authorization: Bearer ${o.password}`,
    '',
    'Step 3. Check what your permission level allows, then do the task.',
    o.mode === 'rw'
      ? 'Every change is saved in the project history and can be rolled back,\nso only change what the task needs.'
      : 'This password is read only.',
    '',
    `(For humans) Project page: ${o.origin}/p/${o.projectId}`,
  ].join('\n');
}
