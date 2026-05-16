import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import { Readable } from 'stream';
import dotenv from 'dotenv';

// Carrega variáveis do ambiente
dotenv.config();

const app = express();

// Permite que o seu site na Netlify faça requisições para cá sem bloqueios de CORS
app.use(cors());

// A MÁGICA ACONTECE AQUI: Liberamos 50MB de Payload para receber os PDFs gigantes
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.post('/api/upload', async (req, res) => {
  try {
    const CLIENT_EMAIL = process.env.FELSEN_DRIVE_CLIENT_EMAIL;
    let PRIVATE_KEY = process.env.FELSEN_DRIVE_PRIVATE_KEY;
    const ROOT_FOLDER_ID = process.env.FELSEN_DRIVE_FOLDER_ID;
    const OWNER_EMAIL = process.env.FELSEN_DRIVE_OWNER_EMAIL;

    if (!CLIENT_EMAIL || !PRIVATE_KEY || !ROOT_FOLDER_ID) {
      return res.status(500).json({ success: false, error: "Credenciais da Conta de Serviço ausentes no painel do Railway." });
    }

    if (PRIVATE_KEY.includes('\\n')) {
      PRIVATE_KEY = PRIVATE_KEY.replace(/\\n/g, '\n');
    }

    const auth = new google.auth.GoogleAuth({
      credentials: { client_email: CLIENT_EMAIL, private_key: PRIVATE_KEY },
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const drive = google.drive({ version: 'v3', auth });

    async function getOrCreateFolder(folderName: string, parentId: string): Promise<string> {
      const query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${parentId}' in parents and trashed=false`;
      const result = await drive.files.list({ q: query, fields: 'files(id, name)' });
      
      if (result.data.files && result.data.files.length > 0) {
        return result.data.files[0].id!;
      }

      const createRes = await drive.files.create({
        requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
        fields: 'id'
      });

      if (createRes.data.id && OWNER_EMAIL) {
        try {
          await drive.permissions.create({
            fileId: createRes.data.id,
            transferOwnership: true,
            requestBody: { role: 'owner', type: 'user', emailAddress: OWNER_EMAIL }
          });
        } catch (e) {
          console.warn(`Aviso: Não foi possível transferir a posse da pasta ${folderName}.`);
        }
      }
      return createRes.data.id!;
    }

    // Recebendo o Payload estruturado em JSON do Front-end
    const { pedidoId, isReplacement, frontPdfBase64, backPdfBase64, dxfContent } = req.body;

    const arpeFolderId = await getOrCreateFolder('ARPE - Aromatizantes Personalizados', ROOT_FOLDER_ID);
    const pedidoFolderId = await getOrCreateFolder(pedidoId || 'Pedido_Ativo', arpeFolderId);

    const filesRes = await drive.files.list({
      q: `'${pedidoFolderId}' in parents and trashed=false`,
      fields: 'files(id, name)'
    });
    
    const existingFiles = filesRes.data.files || [];
    let sequenceNumber = 1;

    if (isReplacement) {
      const filesToDelete = existingFiles.filter(f => f.name?.match(/^1[FVD]\./));
      for (const file of filesToDelete) {
        await drive.files.delete({ fileId: file.id! });
      }
    } else {
      const numbers = existingFiles
        .map(f => parseInt(f.name?.match(/^(\d+)[FVD]\./)?.[1] || '0'))
        .filter(n => !isNaN(n));
      if (numbers.length > 0) {
        sequenceNumber = Math.max(...numbers) + 1;
      }
    }

    const getBufferFromDataUri = (uri: string) => Buffer.from(uri.split(';base64,').pop() || '', 'base64');
    
    const frontBuffer = getBufferFromDataUri(frontPdfBase64 || '');
    const backBuffer = getBufferFromDataUri(backPdfBase64 || '');
    const dxfBuffer = Buffer.from(dxfContent || '', 'utf-8');

    const uploadFile = async (name: string, mimeType: string, buffer: Buffer) => {
      const stream = new Readable();
      stream.push(buffer);
      stream.push(null);
      
      const file = await drive.files.create({
        requestBody: { name, parents: [pedidoFolderId] },
        media: { mimeType, body: stream },
        fields: 'id'
      });

      if (file.data.id) {
         if (OWNER_EMAIL) {
            try {
              await drive.permissions.create({
                fileId: file.data.id,
                transferOwnership: true,
                requestBody: { role: 'owner', type: 'user', emailAddress: OWNER_EMAIL }
              });
            } catch (err) {
              await drive.permissions.create({
                fileId: file.data.id,
                requestBody: { role: 'reader', type: 'anyone' }
              });
            }
         } else {
            await drive.permissions.create({
              fileId: file.data.id,
              requestBody: { role: 'reader', type: 'anyone' }
            });
         }
      }
    };

    await Promise.all([
      uploadFile(`${sequenceNumber}F.pdf`, 'application/pdf', frontBuffer),
      uploadFile(`${sequenceNumber}V.pdf`, 'application/pdf', backBuffer),
      uploadFile(`${sequenceNumber}D.dxf`, 'application/dxf', dxfBuffer)
    ]);

    return res.json({ success: true, message: `Arquivos Folha ${sequenceNumber} salvos com sucesso no Drive!` });

  } catch (error: any) {
    console.error("[Railway Drive API] Erro:", error);
    return res.status(500).json({ success: false, error: error.message || 'Falha interna na API do Railway.' });
  }
});

// Endpoint base para você checar se a API subiu corretamente
app.get('/', (req, res) => {
    res.send('🚀 A API do Drive da Felsen está online e pronta para uploads gigantes!');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
