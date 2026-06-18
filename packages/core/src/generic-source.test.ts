import { describe, expect, it } from 'vitest';

import { matchesRule } from './generic-source.js';

describe('generic source match DSL', () => {
  it('matches string prefixes and suffixes without enabling regex', () => {
    const payload = {
      service: 'komari-node-1',
      status: 'disk-full',
    };

    expect(
      matchesRule(
        {
          all: [
            { op: 'starts_with', path: '$.service', value: 'komari-' },
            { op: 'ends_with', path: '$.status', value: '-full' },
          ],
        },
        payload,
      ),
    ).toBe(true);
    expect(matchesRule({ op: 'starts_with', path: '$.service', value: 'wallos-' }, payload)).toBe(
      false,
    );
    expect(matchesRule({ op: 'ends_with', path: '$.status', value: '-ok' }, payload)).toBe(false);
  });

  it('throws for unsupported match operators instead of silently not matching', () => {
    expect(() =>
      matchesRule(
        {
          op: 'regex',
          path: '$.service',
          value: '.*',
        },
        {
          service: 'komari-node-1',
        },
      ),
    ).toThrow('unsupported match op: regex');
  });
});
