ERP Data Extractor
Extrator automatizado de dados para sistemas ERP via navegador. Captura screenshots de modais e extrai números de telefone usando OCR.
Scripts

src/scraper.mjs — faz login no ERP, aplica filtros nos registros, captura screenshots e salva imagens das declarações
src/extract-phones.cjs — executa OCR nas imagens das declarações, identifica números de telefone e envia os dados para um webhook via POST

Requisitos

Node.js >= 18
Chromium (instalado via Playwright)

Instalação
bashnpm install
npm run install:playwright
cp .env.example .env
Stack utilizada

Playwright — automação de navegador
Tesseract.js — OCR (reconhecimento óptico de caracteres)
node-fetch — cliente HTTP

Licença
MIT
