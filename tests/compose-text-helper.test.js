// tests/compose-text-helper.test.js
// Issue #1023: unit coverage for tests/helpers/compose-text.js, the shared
// indentation-walker tests/compose-port-binding.test.js (#571) and
// tests/compose-logging.test.js (#1023) both route through. Matches the
// sibling precedent tests/helpers/source-text.js <->
// tests/source-text-helper.test.js: the helper's own coverage lives here,
// not only inside its two consumer guards.
'use strict';

const {
  findAppServiceScalarKey,
  findAppServiceBlockKey,
  findAppServiceBlockHeaders,
} = require('./helpers/compose-text');

describe('findAppServiceScalarKey', () => {
  it('reads a direct scalar child of the app service', () => {
    const fixture = ['services:', '  app:', '    network_mode: host'].join('\n');
    expect(findAppServiceScalarKey(fixture, 'network_mode')).toBe('host');
  });

  it('returns undefined when the key is absent', () => {
    const fixture = ['services:', '  app:', '    build: .'].join('\n');
    expect(findAppServiceScalarKey(fixture, 'network_mode')).toBeUndefined();
  });

  it('does not read the key from a different, later service', () => {
    const fixture = [
      'services:',
      '  app:',
      '    build: .',
      '  sidecar:',
      '    network_mode: host',
    ].join('\n');
    expect(findAppServiceScalarKey(fixture, 'network_mode')).toBeUndefined();
  });

  it('still finds a direct child when a deeper-indented comment is the first line under app: (regression)', () => {
    const fixture = [
      'services:',
      '  app:',
      '      # deeper-indented comment placed first',
      '    network_mode: host',
    ].join('\n');
    expect(findAppServiceScalarKey(fixture, 'network_mode')).toBe('host');
  });

  it('resolves a duplicate direct-child key last-occurrence-wins, matching real YAML', () => {
    const fixture = [
      'services:',
      '  app:',
      '    network_mode: bridge',
      '    network_mode: host',
    ].join('\n');
    expect(findAppServiceScalarKey(fixture, 'network_mode')).toBe('host');
  });
});

describe('findAppServiceBlockKey', () => {
  it('reads a nested block child (driver + options) of the app service', () => {
    const fixture = [
      'services:',
      '  app:',
      '    build: .',
      '    logging:',
      '      driver: json-file',
      '      options:',
      "        max-size: '20m'",
      "        max-file: '5'",
      '    restart: unless-stopped',
    ].join('\n');
    expect(findAppServiceBlockKey(fixture, 'logging')).toEqual({
      driver: 'json-file',
      'max-size': '20m',
      'max-file': '5',
    });
  });

  it('returns undefined when the app service has no logging: block', () => {
    const fixture = ['services:', '  app:', '    build: .', '    restart: unless-stopped'].join(
      '\n'
    );
    expect(findAppServiceBlockKey(fixture, 'logging')).toBeUndefined();
  });

  it('does not read a logging: block belonging to a different, later service', () => {
    const fixture = [
      'services:',
      '  app:',
      '    build: .',
      '  sidecar:',
      '    logging:',
      '      driver: json-file',
    ].join('\n');
    expect(findAppServiceBlockKey(fixture, 'logging')).toBeUndefined();
  });

  it('still finds the block when a deeper-indented comment is the first line under app: (regression)', () => {
    const fixture = [
      'services:',
      '  app:',
      '      # deeper-indented comment placed first',
      '    logging:',
      '      driver: json-file',
      '      options:',
      "        max-size: '20m'",
      "        max-file: '5'",
    ].join('\n');
    expect(findAppServiceBlockKey(fixture, 'logging')).toEqual({
      driver: 'json-file',
      'max-size': '20m',
      'max-file': '5',
    });
  });

  it('resolves a duplicate top-level logging: block last-occurrence-wins, matching real YAML', () => {
    const fixture = [
      'services:',
      '  app:',
      '    logging:',
      '      driver: json-file',
      '      options:',
      "        max-size: '20m'",
      "        max-file: '5'",
      '    logging:',
      '      driver: json-file',
      '      options:',
      "        max-size: '2000m'",
      "        max-file: '5'",
    ].join('\n');
    expect(findAppServiceBlockKey(fixture, 'logging')).toEqual({
      driver: 'json-file',
      'max-size': '2000m',
      'max-file': '5',
    });
  });
});

describe('findAppServiceBlockHeaders', () => {
  it('reports the nested block-header children of a block (e.g. options under logging)', () => {
    const fixture = [
      'services:',
      '  app:',
      '    logging:',
      '      driver: json-file',
      '      options:',
      "        max-size: '20m'",
      "        max-file: '5'",
    ].join('\n');
    expect(findAppServiceBlockHeaders(fixture, 'logging')).toEqual(new Set(['options']));
  });

  it('does not report options when the caps are written as flat siblings of driver, no options: wrapper', () => {
    const fixture = [
      'services:',
      '  app:',
      '    logging:',
      '      driver: json-file',
      "      max-size: '20m'",
      "      max-file: '5'",
    ].join('\n');
    expect(findAppServiceBlockHeaders(fixture, 'logging')).toEqual(new Set());
  });

  it('returns undefined when the block itself is absent', () => {
    const fixture = ['services:', '  app:', '    build: .'].join('\n');
    expect(findAppServiceBlockHeaders(fixture, 'logging')).toBeUndefined();
  });
});
