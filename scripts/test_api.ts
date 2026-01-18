import './loadEnv';
import { GoogleGenAI } from "@google/genai";

async function testConnection() {
    const apiKey = process.env.VITE_GEMINI_API_KEY;
    if (!apiKey) {
        console.error("API Key missing");
        return;
    }
    
    const ai = new GoogleGenAI({ apiKey });

    try {
        console.log("Testing connection to Gemini API using ai.models.generateContent...");
        // Using a known model from the project's service
        const response = await ai.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: 'Say hello'
        });
        console.log("Response:", response.text);
        console.log("Connection successful!");
    } catch (error) {
        console.error("Connection failed:", error);
    }
}

testConnection();