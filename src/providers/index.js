// src/providers/index.js — provider selector. Full-VLM supports Groq only.

import { makeGroqAdapter } from "./groq.js";

export function makeProvider(_name = "groq") {
  return makeGroqAdapter();
}
