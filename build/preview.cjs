const path = require('node:path');
const base = require('../package.json').build;

// An independently named local preview. It registers its own
// gongzuo-preview:// scheme and never replaces the installed production app.
module.exports = {
  ...base,
  appId: 'cn.gongzuo.agent.preview',
  productName: '共作预览版',
  protocols: [{ name: '共作预览版工作链接', schemes: ['gongzuo-preview'] }],
  extraMetadata: { gongzuoChannel: 'preview' },
  directories: {
    ...base.directories,
    output: path.resolve(__dirname, '../../outputs')
  },
  artifactName: '${productName}-${version}-${arch}.${ext}',
  mac: { ...base.mac, target: ['zip', 'dmg'] }
};
