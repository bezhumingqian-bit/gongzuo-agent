const path = require('node:path');
const fs = require('node:fs');

// The preview uses its own link scheme so links it sends (WeCom reminders etc.)
// open the preview and its data, never the production app.
let currentScheme = 'gongzuo';

function channelOptions(metadata, appData, userDataOverride = '') {
  const preview = metadata.gongzuoChannel === 'preview';
  return {
    preview,
    displayName: preview ? '共作预览版' : '共作',
    userData: userDataOverride || (preview ? path.join(appData, 'gongzuo-agent-dev') : null),
    scheme: preview ? 'gongzuo-preview' : 'gongzuo',
    registerProtocol: true
  };
}

const taskLink = id => `${currentScheme}://task/${encodeURIComponent(id)}`;
const linkScheme = () => currentScheme;

function configureRuntimeChannel(app, metadata) {
  const options = channelOptions(metadata, app.getPath('appData'), app.commandLine.getSwitchValue('user-data-dir'));
  currentScheme = options.scheme;
  if (options.preview) app.setName(options.displayName);
  if (options.userData) {
    fs.mkdirSync(options.userData, { recursive: true, mode: 0o700 });
    app.setPath('userData', options.userData);
    app.setPath('sessionData', options.userData);
  }
  return options;
}

module.exports = { channelOptions, configureRuntimeChannel, taskLink, linkScheme };
