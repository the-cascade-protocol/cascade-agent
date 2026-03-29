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

console.log('Assets copied: src/prompts -> dist/prompts');
