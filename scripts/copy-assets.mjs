/**
 * Post-build asset copy: copies non-TypeScript files from src/ to dist/
 * that are needed at runtime (e.g. JSON prompt templates).
 */
import { cpSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Copy prompt templates JSON
const srcPrompts = join(root, 'src', 'prompts');
const dstPrompts = join(root, 'dist', 'prompts');
mkdirSync(dstPrompts, { recursive: true });
cpSync(srcPrompts, dstPrompts, { recursive: true });

// Copy the stamped tier table snapshot. The tier table loader reads it at
// module load, so a dist/ without it cannot resolve a tier to a model and the
// process refuses to start rather than guessing one.
const srcData = join(root, 'src', 'data');
const dstData = join(root, 'dist', 'data');
mkdirSync(dstData, { recursive: true });
cpSync(srcData, dstData, { recursive: true });

console.log('Assets copied: src/prompts -> dist/prompts, src/data -> dist/data');
