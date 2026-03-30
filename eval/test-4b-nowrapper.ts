import { join } from "path";
import { homedir } from "os";

const MODEL_PATH = join(homedir(), ".config/cascade-agent/models/Qwen3.5-4B-Q4_K_M.gguf");

async function main() {
  console.log("Loading model...");
  const nlc = await import("node-llama-cpp");
  const { getLlama, LlamaChatSession } = nlc;
  
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath: MODEL_PATH });
  console.log("Model loaded. Creating context...");
  
  const context = await model.createContext({ contextSize: 512 });
  console.log("Context created. Creating session WITHOUT QwenChatWrapper...");
  
  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: "You are a helpful assistant.",
  });
  
  console.log("Running prompt...");
  const text = await session.prompt("Say hello in one word.", { maxTokens: 20, temperature: 0.15 });
  console.log("Output:", JSON.stringify(text));
  
  await context.dispose();
  await model.dispose();
  await llama.dispose();
  console.log("Done.");
}

main().catch(console.error);
