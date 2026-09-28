#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || process.argv.length > 4) {
  console.error('Usage: node misc/strip-transcript.js <input.jsonl> [output.jsonl]');
  process.exit(2);
}

const defaultOutput = /\.jsonl$/i.test(inputPath) ? inputPath.replace(/\.jsonl$/i, '.stripped.jsonl') : `${inputPath}.stripped.jsonl`;
const resolvedInput = path.resolve(inputPath);
const resolvedOutput = path.resolve(outputPath || defaultOutput);
if (resolvedInput === resolvedOutput || path.resolve(scriptPath) === resolvedOutput) {
  throw new Error('Input and output paths must differ from the script path.');
}

const agentTermPrefix = 'mcp__agent-term__';
const output = [];
const pendingCalls = new Map();
const emittedDialog = new Set();

function pushDialog(role, text) {
  const key = `${role}\0${text}`;
  if (emittedDialog.has(key)) return;
  emittedDialog.add(key);
  output.push({ type: 'conversation', role, text });
}

function dialogText(record, text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  if (record.type === 'user') {
    const commandArgs = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    if (commandArgs) return commandArgs[1].trim() || null;
    if (record.isMeta) {
      const argumentsText = text.match(/\n\s*ARGUMENTS:\s*([\s\S]*)$/);
      if (argumentsText) return argumentsText[1].trim() || null;
      if (/<command-name>\//.test(text)) return null;
    }
    if (record.origin?.kind !== 'human') return null;
  }
  return text;
}

function compactUsage(usage) {
  return {
    inputTokens: usage.input_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.output_tokens_details?.thinking_tokens !== undefined
      ? { thinkingTokens: usage.output_tokens_details.thinking_tokens }
      : {}),
  };
}

for (const [index, line] of fs.readFileSync(resolvedInput, 'utf8').split(/\r?\n/).entries()) {
  if (!line.trim()) continue;

  let record;
  try {
    record = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid JSON on line ${index + 1}: ${error.message}`);
  }

  const { message } = record;
  const content = message?.content;
  const timestamp = record.timestamp;

  if (record.type === 'assistant') {
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          const text = dialogText(record, block.text);
          if (text) pushDialog('assistant', text);
        }
        if (block.type === 'tool_use' && block.name?.startsWith(agentTermPrefix)) {
          pendingCalls.set(block.id, true);
          output.push({
            type: 'jsonrpc',
            direction: 'request',
            jsonrpc: '2.0',
            id: block.id,
            method: 'tools/call',
            params: { name: block.name, arguments: block.input },
            timestamp,
          });
        }
      }
    }
    if (message?.usage) {
      output.push({ type: 'token_statistics', ...compactUsage(message.usage) });
    }
    continue;
  }

  if (record.type !== 'user') continue;
  if (typeof content === 'string') {
    const text = dialogText(record, content);
    if (text) pushDialog('user', text);
    continue;
  }
  if (!Array.isArray(content)) continue;

  for (const block of content) {
    if (block.type === 'text') {
      const text = dialogText(record, block.text);
      if (text) pushDialog('user', text);
    }
    if (block.type === 'tool_result' && pendingCalls.delete(block.tool_use_id)) {
      output.push({
        type: 'jsonrpc',
        direction: 'response',
        jsonrpc: '2.0',
        id: block.tool_use_id,
        result: block.content,
        ...(block.isError ? { isError: true } : {}),
        timestamp,
      });
    }
  }
}

fs.writeFileSync(resolvedOutput, output.map(record => JSON.stringify(record)).join('\n') + '\n');
console.log(`Wrote ${output.length} records to ${resolvedOutput}`);
