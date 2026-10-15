const { GoogleGenerativeAI } = require('@google/generative-ai');

const KEY = process.argv[2];
if (!KEY) { console.error('Usage: node test-gemini.js YOUR_API_KEY'); process.exit(1); }

const genAI = new GoogleGenerativeAI(KEY);

async function main() {
  const models = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash-lite'];
  for (const name of models) {
    try {
      const model = genAI.getGenerativeModel({ model: name });
      const result = await model.generateContent('Say hello in French in one sentence.');
      console.log(`✅ ${name}: ${result.response.text().trim()}`);
    } catch (e) {
      console.log(`❌ ${name}: ${e.message}`);
    }
  }
}

main();
