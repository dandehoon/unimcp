#!/usr/bin/env node
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(__dirname, "..", "dist", "unimcp.js");

// Dynamically import the pre-built bundle — runs in the same Node.js process.
await import(bundle);
