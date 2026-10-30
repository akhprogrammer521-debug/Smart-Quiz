# SmartQuiz

A Next.js foundation for an AI-powered study and assessment platform. It includes account registration, a protected dashboard, private document uploads, and document summaries.

## Run locally

```bash
npm install
npm run db:generate
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Checks

```bash
npm run lint
npm run build
```

The project uses the App Router, TypeScript, Tailwind CSS, ESLint, Prisma, and Auth.js. Application code lives in `src/`. Prisma keeps its schema and migrations in `prisma/`.

The existing `.env` supplies `DATABASE_URL` for application queries and `DIRECT_URL` for migrations. Auth.js also needs `AUTH_SECRET`; keep it in an ignored local environment file or your deployment environment. Never commit credentials.

To create a new migration after changing the schema, run `npm run db:migrate -- --name description`. To apply committed migrations in deployment, run `npm run db:deploy`.

## Document storage

Set `NEXT_PUBLIC_SUPABASE_URL` to the Supabase project URL, `SUPABASE_SECRET_KEY` to a server-side secret key, and `SUPABASE_STORAGE_BUCKET` to an existing **private** Storage bucket. Keep the secret key out of client code and source control. Apply migrations with `npm run db:deploy` before uploading documents.

The documents page accepts PDF, DOCX, DOC, TXT, PNG, and JPG files up to 15 MB. Uploaded files remain in the private bucket. Legacy DOC summarization requires LibreOffice on the Python service host.

## Document summaries

Apply the summary migration with `npm run db:deploy`. Set `AI_SUMMARIZATION_SERVICE_URL=http://127.0.0.1:5000` in the Next.js server environment. Do not prefix this variable with `NEXT_PUBLIC_`. Set `GEMINI_API_KEY` only in the Python service environment; Next.js does not need it.

In a separate terminal, start the existing Flask service from its own directory:

```powershell
cd "ai_services/summarization_feature/summarization_feature"
python -m pip install -r requirements.txt
python summarization_api.py
```

The Flask service listens on port 5000. Its `/api/summarize` endpoint receives the private file from the Next.js server, extracts and normalizes its text, and requests a Gemini summary. Image summaries also require the Tesseract OCR executable installed on the Python host. The service URL is used only by Next.js server code.

To summarize legacy `.doc` files on Windows, install LibreOffice with `winget install --id TheDocumentFoundation.LibreOffice --exact`. The service finds `soffice` on PATH or in the standard Windows install directory; set `LIBREOFFICE_PATH` to its executable for a custom installation.

## Short-answer questions

Apply migrations with `npm run db:deploy`, then set `AI_QUESTION_SERVICE_URL=http://127.0.0.1:5001` in the Next.js server environment. Start the existing local model service in a separate terminal:

```powershell
cd "ai_services/questions_generation_eature"
python -m pip install -r requirements.txt
python .\api.py
```

Question generation uses the document's saved normalized source text after summarization has prepared it. The service supports a requested question count but does not accept a difficulty filter or return model answers, so saved `correctAnswer` values remain empty unless the service supplies them in the future.

## Multiple-choice questions

Set `AI_MCQ_SERVICE_URL=http://127.0.0.1:5002` in the Next.js server environment. Do not prefix this variable with `NEXT_PUBLIC_`. The existing Flask endpoint is `POST /generate` and receives the document's normalized source text from the Next.js server.

The MCQ service returns question text, labeled options, and the trained model's `correctAnswer` label. Next.js maps that label to the matching option text used by the existing quiz answer routes. Retrain the model after changing its target format so generated output includes `ANSWER: A`, `B`, `C`, or `D`.

## True/False questions

Set `AI_TRUE_FALSE_SERVICE_URL=http://127.0.0.1:5003` in the Next.js server environment. Do not prefix this variable with `NEXT_PUBLIC_`. Start the existing service in a separate terminal:

```powershell
cd "ai_services/gpt2_boolq_qlora"
python .\api.py
```

The Next.js server sends the document's saved normalized source text to the private service and stores only validated questions and their True/False answers. The model service is not called from the browser.

## AI quiz grading

Apply the grading migration with `npm run db:deploy`. Set the same strong `AI_SERVICE_INTERNAL_KEY` value in the Next.js server environment and the Python summarization service environment. This key protects `/api/grade-short-answer` and must never use a `NEXT_PUBLIC_` prefix. Grading also uses the existing `AI_SUMMARIZATION_SERVICE_URL` in Next.js and `GEMINI_API_KEY` only in Python.

Start the Gemini service locally with:

```powershell
cd "ai_services/summarization_feature/summarization_feature"
python -m pip install -r requirements.txt
python summarization_api.py
```

The grader evaluates submitted short answers against the document's saved normalized source text. It does not use the generated summary. Ambiguous answers are marked for review and receive no automatic points.
