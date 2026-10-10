const path = require('node:path');

const config = {
  mcpServers: {
    gongzuo: {
      type: 'stdio',
      command: process.execPath,
      args: [path.resolve(__dirname, '../integrations/workbuddy/gongzuo-mcp.cjs')],
      timeout: 30000
    }
  }
};

process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
