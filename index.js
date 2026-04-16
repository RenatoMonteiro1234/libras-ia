require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const upload = multer({
    dest: '/tmp/uploads/',
    limits: { fileSize: 2000 * 1024 * 1024 }
});

if (!fs.existsSync('/tmp/uploads')) fs.mkdirSync('/tmp/uploads', { recursive: true });

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function transcreverAudio(caminhoArquivo) {
    console.log('Fazendo upload do arquivo...');
    const fileData = fs.readFileSync(caminhoArquivo);

    const uploadResp = await axios.post('https://api.assemblyai.com/v2/upload', fileData, {
        headers: {
            'Authorization': 'Basic ' + process.env.DID_API_KEY,
            'content-type': 'application/octet-stream'
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
    });

    console.log('Upload feito! Transcrevendo...');
    const audioUrl = uploadResp.data.upload_url;

    const transcriptResp = await axios.post('https://api.assemblyai.com/v2/transcript', {
        audio_url: audioUrl,
        language_code: 'pt',
        speech_models: ['universal-2']
    }, {
        headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }
    });

    const transcriptId = transcriptResp.data.id;
    console.log('Aguardando transcrição ID:', transcriptId);

    while (true) {
        await new Promise(r => setTimeout(r, 3000));
        const check = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
            headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }
        });
        console.log('Status:', check.data.status);
        if (check.data.status === 'completed') return check.data.text;
        if (check.data.status === 'error') throw new Error('Erro: ' + check.data.error);
    }
}

async function gerarAvatarLibras(texto) {
    console.log('Gerando avatar D-ID...');
    const textoResumido = texto.substring(0, 500);

    const response = await axios.post('https://api.d-id.com/talks', {
        script: {
            type: 'text',
            input: textoResumido,
            provider: {
                type: 'microsoft',
                voice_id: 'pt-BR-FranciscaNeural'
            }
        },
        source_url: 'https://clips-presenters.d-id.com/amy/image.png'
    }, {
        headers: {
            'Authorization': 'Basic ' + process.env.DID_API_KEY,
            'Content-Type': 'application/json'
        }
    });

    const talkId = response.data.id;
    console.log('Avatar ID:', talkId);

    while (true) {
        await new Promise(r => setTimeout(r, 3000));
        const check = await axios.get(`https://api.d-id.com/talks/${talkId}`, {
            headers: {
                'Authorization': 'Basic ' + process.env.DID_API_KEY
            }
        });
        console.log('Avatar status:', check.data.status);
        if (check.data.status === 'done') return check.data.result_url;
        if (check.data.status === 'error') throw new Error('Erro avatar: ' + check.data.error);
    }
}

app.post('/processar', upload.single('video'), async (req, res) => {
    try {
        console.log('Vídeo recebido:', req.file.originalname);
        const texto = await transcreverAudio(req.file.path);
        console.log('Transcrito! Gerando avatar...');
        const avatarUrl = await gerarAvatarLibras(texto);
        console.log('Avatar gerado:', avatarUrl);
        fs.unlinkSync(req.file.path);
        res.json({
            status: 'concluido',
            transcricao: texto,
            avatar_url: avatarUrl
        });
    } catch (error) {
        console.error('Erro:', error.message);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ erro: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});
module.exports = app;
