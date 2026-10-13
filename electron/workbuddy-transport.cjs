// Which channel a WorkBuddy-assigned work item uses.
// - handoff:        WorkBuddy pulls the work through the local MCP bridge (no credentials).
// - localassistant: Open API drives the user's PC WorkBuddy (OAuth token).
// - cloud:          Open API cloud task + ACP stream (OAuth token).
// Old settings without an explicit choice keep their previous behavior:
// a saved token meant local assistant, no token meant hand-off.
const TRANSPORTS = ['handoff', 'localassistant', 'cloud'];

function workbuddyTransport(agentSettings, hasToken) {
  const chosen = agentSettings?.workbuddyTransport;
  if (TRANSPORTS.includes(chosen)) return chosen;
  return hasToken ? 'localassistant' : 'handoff';
}

const transportOf = config => workbuddyTransport(config?.agent, Boolean(config?.workbuddyAccessToken));
const needsToken = transport => transport !== 'handoff';

module.exports = { TRANSPORTS, workbuddyTransport, transportOf, needsToken };
