// ShadeXX webpack config
//
// Five entry points → five bundles in dist/:
//   - background.js  (MV3 service worker — message broker + offscreen lifecycle)
//   - content.js     (content script, ISOLATED world)
//   - popup.js       (popup UI)
//   - offscreen.js   (offscreen extension page — bridges chrome.runtime ↔ sandbox iframe)
//   - sandbox.js     (sandbox page — hosts xxdk-wasm, runs in null origin with permissive CSP)
//
// public/ is copied verbatim (manifest.json, popup.html, offscreen.html, sandbox.html).
// node_modules/xxdk-wasm/dist/ is copied to dist/xxdk-wasm/dist/ so that
// xxdk-wasm's hardcoded `/dist/...` path prefix resolves correctly.
//
// devtool note: MV3 service workers reject eval-based source maps under the
// default CSP. 'source-map' generates separate .map files (no eval) and is
// safe for the SW.

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isDev = argv.mode === 'development';

  return {
    mode: argv.mode || 'production',
    devtool: isDev ? 'source-map' : false,
    entry: {
      background: './src/background/background.js',
      content: './src/content/interceptor.js',
      popup: './src/popup/popup.js',
      offscreen: './src/offscreen/offscreen.js',
      sandbox: './src/sandbox/sandbox.js',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true,
    },
    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: { loader: 'babel-loader' },
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: 'public', to: '.' },
          {
            // Self-host xxdk-wasm assets. Required for MV3 (no remote code).
            // Must preserve the `dist/` subfolder — xxdk-wasm internally
            // constructs URLs as `<basePath>/dist/wasm_exec.js` etc.
            from: 'node_modules/xxdk-wasm/dist',
            to: 'xxdk-wasm/dist',
            globOptions: { ignore: ['**/*.d.ts', '**/*.map'] },
          },
        ],
      }),
    ],
    resolve: {
      extensions: ['.js'],
    },
    performance: {
      hints: false,
    },
  };
};
