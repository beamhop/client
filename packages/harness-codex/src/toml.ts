import type { SessionSpec } from '@beamhop/core';

/** JSON string literal is a valid TOML basic string for the characters JSON.stringify emits. */
const tomlString = (s: string): string => JSON.stringify(s);
const tomlKey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));

/** `-c` overrides that register SessionSpec MCP servers with codex (`mcp_servers.<name>.*`). */
export const mcpConfigArgs = (servers: SessionSpec['mcpServers']): string[] =>
  servers.flatMap((s) => {
    const base = `mcp_servers.${tomlKey(s.name)}`;
    const args = [
      '-c',
      `${base}.command=${tomlString(s.command)}`,
      '-c',
      `${base}.args=[${s.args.map(tomlString).join(', ')}]`,
    ];
    const env = Object.entries(s.env ?? {});
    if (env.length) {
      args.push(
        '-c',
        `${base}.env={ ${env.map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(', ')} }`,
      );
    }
    return args;
  });
