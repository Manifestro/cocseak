import assert from "node:assert/strict";
import { test } from "node:test";

import { holdsCredential } from "../src/secrets.js";

test("recognises the credential shapes KAP redacts", () => {
  for (const sample of [
    "HF_TOKEN=hf_abcdefghijklmnopqrstuvwxyz",
    "export RUNPOD_API_KEY=Zq81mXk20Lp3nV7c",
    '{"api_key": "Zq81mXk20Lp3nV7c"}',
    "Authorization: Bearer Zq81mXk20Lp3nV7c",
    "git clone https://user:Zq81mXk20Lp3nV7c@github.com/x/y",
    "token: Zq81mXk20Lp3nV7c",
    "login --password Zq81mXk2",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "key: q7Lr2VxN9mKp4TzB8wYc1HdF6jGs3EaU",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "machine api.wandb.ai login user password 0123456789abcdef0123456789abcdef01234567",
  ]) {
    assert.ok(holdsCredential(sample), `missed: ${sample}`);
  }
});

test("leaves ordinary code and training logs alone", () => {
  for (const sample of [
    "step 1200  loss 2.314  num_tokens=12000000",
    "max_new_tokens=2048 tokenizer=mimi_tokenizer_v2",
    "eos_token: </s>",
    "https://huggingface.co/datasets/x/y",
    "def tokenize(text):\n    return text.split()",
    "commit 6ba810789f2a1c3d4e5f60718293a4b5c6d7e8f9",
    "blake3:bd34aa745853dc530f70cfbb7a83276aa72f1189ebdf8c36216cd1f47d0c6d41",
    "c0062-f09-af_nova-en_GB-jenny_dioco-medium",
    "/Users/karl4th/Documents/manifestro/research/dauys/checkpoints/E3",
    "client = AsyncOpenAI(base_url=args.base_url, api_key=args.api_key)",
    "tokenizer.pad_token = tokenizer.eos_token",
    'echo "password=$GH_TOKEN"',
    'token = os.environ.get("WANDB_API_KEY")',
  ]) {
    assert.equal(holdsCredential(sample), false, `false positive: ${sample}`);
  }
});
