import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(root);
process.env.NODE_ENV = 'production';
process.env.CI = 'true';
const webpack = require('webpack');
const config = require('../../webpack.config.js');
webpack(config, (error, stats) => {
    if (error) {
        console.error(error.message);
        process.exitCode = 1;
        return;
    }
    const summary = stats.toJson({all: false, hash: true, errors: true, warnings: true});
    console.log(JSON.stringify({hash: summary.hash, errors: summary.errors,
        warningCount: summary.warnings?.length || 0, warnings: summary.warnings?.slice(0, 3)}, null, 2));
    process.exitCode = stats.hasErrors() ? 1 : 0;
});
