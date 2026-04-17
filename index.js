require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const uploadDir = process.env.NODE_ENV === 'production' ? '/tmp/uploads' : 'uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 2000 * 1024 * 1024 }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function transcreverAudio(caminhoArquivo) {
    console.log('Fazendo upload do arquivo...');
    const fileData = fs.readFileSync(caminhoArquivo);

    const uploadResp = await axios.post('https://api.assemblyai.com/v2/upload', fileData, {
        headers: {
            'Authorization': process.env.ASSEMBLYAI_API_KEY,
            'content-type': 'application/octet-stream'
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
    });

    console.log('Upload feito! Transcrevendo...');
    const audioUrl = uploadResp.data.upload_url;

    const transcriptResp = await axios.post('https://api.assemblyai.com/v2/transcript', {
        audio_url: audioUrl
    }, {
        headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }
    }).catch(e => { throw new Error('AssemblyAI 400: ' + JSON.stringify(e.response?.data)); });

    const transcriptId = transcriptResp.data.id;
    console.log('Aguardando transcrição ID:', transcriptId);

    while (true) {
        await new Promise(r => setTimeout(r, 3000));
        const check = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
            headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }
        });
        console.log('Enviando para AssemblyAI, URL:', audioUrl);
        if (check.data.status === 'completed') return check.data.text;
        if (check.data.status === 'error') throw new Error('Erro AssemblyAI: ' + JSON.stringify(check.data));
    }
}

async function gerarAvatarLibras(texto) {
    console.log('Gerando avatar D-ID...');
    const textoResumido = texto.substring(0, 500);
    const didAuth = 'Basic ' + process.env.DID_API_KEY;

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
            'Authorization': didAuth,
            'Content-Type': 'application/json'
        }
    });

    const talkId = response.data.id;
    console.log('Avatar ID:', talkId);

    while (true) {
        await new Promise(r => setTimeout(r, 3000));
        const check = await axios.get(`https://api.d-id.com/talks/${talkId}`, {
            headers: { 'Authorization': didAuth }
        });
        console.log('Avatar status:', check.data.status);
        if (check.data.status === 'done') return check.data.result_url;
        if (check.data.status === 'error') throw new Error('Erro avatar: ' + check.data.error);
    }
}

async function baixarVideo(url, destino) {
    console.log('Baixando vídeo do avatar...');
    const response = await axios.get(url, { responseType: 'stream' });
    const writer = fs.createWriteStream(destino);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function aplicarOverlay(videoOriginal, videoAvatar, videoFinal) {
    console.log('Aplicando overlay FFmpeg...');
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(videoOriginal)
            .input(videoAvatar)
            .complexFilter([
                '[1:v]scale=320:240[avatar]',
                '[0:v][avatar]overlay=W-w-20:H-h-20[out]'
            ])
            .outputOptions([
                '-map [out]',
                '-map 0:a?',
                '-c:v libx264',
                '-c:a aac',
                '-shortest'
            ])
            .output(videoFinal)
            .on('start', cmd => console.log('FFmpeg iniciado:', cmd))
            .on('progress', p => console.log('Progresso:', p.percent?.toFixed(1) + '%'))
            .on('end', () => { console.log('Overlay concluído!'); resolve(); })
            .on('error', (err) => { console.error('Erro FFmpeg:', err.message); reject(err); })
            .run();
    });
}

app.post('/processar', upload.single('video'), async (req, res) => {
    const arquivosParaLimpar = [];

    try {
        console.log('Vídeo recebido:', req.file.originalname);
        arquivosParaLimpar.push(req.file.path);

        // 1. Transcreve o áudio
        const texto = await transcreverAudio(req.file.path);
        console.log('Transcrito!');

        // 2. Gera o avatar D-ID
        const avatarUrl = await gerarAvatarLibras(texto);
        console.log('Avatar gerado:', avatarUrl);

        // 3. Baixa o avatar
        const avatarPath = path.join(uploadDir, `avatar_${Date.now()}.mp4`);
        arquivosParaLimpar.push(avatarPath);
        await baixarVideo(avatarUrl, avatarPath);

        // 4. Aplica overlay
        const videoFinalPath = path.join(uploadDir, `final_${Date.now()}.mp4`);
        arquivosParaLimpar.push(videoFinalPath);
        await aplicarOverlay(req.file.path, avatarPath, videoFinalPath);

        // 5. Envia o vídeo final para o usuário
        res.download(videoFinalPath, 'video_com_libras.mp4', (err) => {
            arquivosParaLimpar.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
            if (err) console.error('Erro no download:', err.message);
        });

    } catch (error) {
        console.error('Erro:', error.message);
        arquivosParaLimpar.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        res.status(500).json({ erro: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});

module.exports = app;