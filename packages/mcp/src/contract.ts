/**
 * The agent-tool contract, as both runtimes see it.
 *
 * `@cancore/mcp` (TypeScript) and `Cancore-io/mcp-server` (Go) serve the same
 * six tools and share one grant file. That is only true while their tool
 * surfaces stay identical, and nothing enforced it: two codebases, two
 * languages, one promise. `contract/agent-tools.contract.json` is that promise
 * written down, and each repository tests its own `tools/list` against its copy.
 *
 * A PROJECTION rather than the raw schema on purpose: zod and mcp-go emit
 * different JSON Schema dialects (`$schema`, `additionalProperties`, ordering)
 * that mean nothing to an agent. What an agent reads is the tool's name, its
 * description, which arguments exist, their types and their descriptions, and
 * which are required — so that is what the contract holds, sorted, so the file
 * diffs cleanly.
 */

export interface ContractArgument {
  type: string;
  description: string;
}

export interface ContractTool {
  name: string;
  description: string;
  required: string[];
  arguments: Record<string, ContractArgument>;
}

/** The shape `tools/list` returns, reduced to what the projection reads. */
export interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, { type?: string | string[]; description?: string }>;
    required?: string[];
  };
}

export const AGENT_TOOL_PREFIX = 'cancore_';

export function projectTools(tools: ListedTool[]): ContractTool[] {
  return tools
    .filter((tool) => tool.name.startsWith(AGENT_TOOL_PREFIX))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => {
      const properties = tool.inputSchema?.properties ?? {};
      const args: Record<string, ContractArgument> = {};
      for (const key of Object.keys(properties).sort()) {
        const prop = properties[key] ?? {};
        args[key] = {
          type: Array.isArray(prop.type) ? prop.type.join('|') : (prop.type ?? ''),
          description: prop.description ?? '',
        };
      }
      return {
        name: tool.name,
        description: tool.description ?? '',
        required: [...(tool.inputSchema?.required ?? [])].sort(),
        arguments: args,
      };
    });
}
