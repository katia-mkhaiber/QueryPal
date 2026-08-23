const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const PYTHON_AI_URL = process.env.PYTHON_AI_URL || 'http://127.0.0.1:8000';

async function getAIResponse(userMessage, hasFile = false, fileType = null) {
    try {
        const response = await axios.post(`${PYTHON_AI_URL}/chat`, {
            text: userMessage,
            has_file: hasFile,
            file_type: fileType
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });
        
        return response.data.reply;
    } catch (error) {
        console.error("Python AI Error:", error.message);
        return null;
    }
}

async function processFile(filePath, fileName, fileType) {
    try {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath), {
            filename: fileName,
            contentType: fileType
        });
        
        const response = await axios.post(`${PYTHON_AI_URL}/process-file`, formData, {
            headers: { ...formData.getHeaders() },
            timeout: 30000
        });
        
        return response.data;
    } catch (error) {
        console.error("File processing error:", error.message);
        return { success: false, error: error.message };
    }
}

module.exports = { getAIResponse, processFile };