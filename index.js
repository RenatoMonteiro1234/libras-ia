require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const puppeteer = require('puppeteer');

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
        audio_url: audioUrl,
        speech_models: ['universal-2']
    }, {
        headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }
    }).catch(e => { throw new Error('AssemblyAI erro: ' + JSON.stringify(e.response?.data)); });

    const transcriptId = transcriptResp.data.id;
    console.log('Aguardando transcrição ID:', transcriptId);

    while (true) {
        await new Promise(r => setTimeout(r, 3000));
        const check = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
            headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY }
        });
        console.log('Status:', check.data.status);
        if (check.data.status === 'completed') return check.data.text;
        if (check.data.status === 'error') throw new Error('Erro AssemblyAI: ' + JSON.stringify(check.data));
    }
}

async function gerarAvatarVLibras(texto, destinoPath) {
    console.log('Abrindo navegador para gravar VLibras...');
    const textoResumido = texto.substring(0, 500);

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 320, height: 240 });

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { margin: 0; background: #fff; overflow: hidden; }
        div[vw] { position: fixed; bottom: 0; right: 0; width: 320px; height: 240px; }
        .vw-plugin-top-wrapper { display: none; }
      </style>
    </head>
    <body>
      <div vw class="enabled">
        <div vw-access-button class="active" style="display:none"></div>
        <div vw-plugin-wrapper>
          <div class="vw-plugin-top-wrapper"></div>
        </div>
      </div>
      <script src="https://vlibras.gov.br/app/vlibras-plugin.js"></script>
      <script>
        new window.VLibras.Widget('https://vlibras.gov.br/app');
        window.addEventListener('load', function() {
          setTimeout(function() {
            window.VLibras.translate("${textoResumido.replace(/"/g, '\\"')}");
          }, 3000);
        });
      </script>
    </body>
    </html>`;

    await page.setContent(html);

    // Aguarda o VLibras carregar e começar a sinalizar
    await new Promise(r => setTimeout(r, 4000));

    // Grava frames por 30 segundos
    const frames = [];
    const totalFrames = 30 * 10; // 10 fps por 30s
    for (let i = 0; i < totalFrames; i++) {
        const frame = await page.screenshot({ type: 'jpeg', quality: 80 });
        frames.push(frame);
        await new Promise(r => setTimeout(r, 100));
    }

    await browser.close();
    console.log('Frames capturados:', frames.length);

    // Converte frames em vídeo
    const framesDir = path.join(uploadDir, `frames_${Date.now()}`);
    fs.mkdirSync(framesDir, { recursive: true });
    frames.forEach((f, i) => {
        fs.writeFileSync(path.join(framesDir, `frame${String(i).padStart(4, '0')}.jpg`), f);
    });

    await new Promise((resolve, reject) => {
        ffmpeg()
            .input(path.join(framesDir, 'frame%04d.jpg'))
            .inputFPS(10)
            .output(destinoPath)
            .videoCodec('libx264')
            .outputFPS(10)
            .on('end', resolve)
            .on('error', reject)
            .run();
    });

    // Limpa frames
    fs.rmSync(framesDir, { recursive: true });
    console.log('Vídeo VLibras gerado!');
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

        const texto = await transcreverAudio(req.file.path);
        console.log('Transcrito!');

        const avatarPath = path.join(uploadDir, `avatar_${Date.now()}.mp4`);
        arquivosParaLimpar.push(avatarPath);
        await gerarAvatarVLibras(texto, avatarPath);

        const videoFinalPath = path.join(uploadDir, `final_${Date.now()}.mp4`);
        arquivosParaLimpar.push(videoFinalPath);
        await aplicarOverlay(req.file.path, avatarPath, videoFinalPath);

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