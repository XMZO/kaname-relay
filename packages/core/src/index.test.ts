import { describe, expect, it } from 'vitest';

import { createWorkspaceHealth } from './index.js';

describe('createWorkspaceHealth', () => {
  it('returns the M0 workspace health marker', () => {
    expect(createWorkspaceHealth()).toEqual({
      name: 'kaname-relay',
      ready: true,
    });
  });
});
