# DeadlineHub

DeadlineHub is a CS 409 prototype that turns course syllabi and natural-language reminders into a private deadline agenda. It uses React, Express, SQLite, Google sign-in, and the OpenAI Responses API.

## Run locally

Install Node.js 22.13 or newer, then run these commands from the repository root.

```sh
npm ci
cp -n .env.example .env
```

### Try the sample without credentials

```sh
DEMO_MODE=true npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and click **Open local demo**. From the agenda, choose **Import syllabus** and click **Try sample syllabus** to open an editable preview. You can also use **Quick add**. Each demo sign-in starts a separate local account.

### Enable Google sign-in and live syllabus extraction

1. In [Google Auth Platform](https://console.cloud.google.com/auth/clients), create an OAuth client of type **Web application**. Add `http://localhost:3000/auth/google/callback` under **Authorized redirect URIs**. If you change `APP_ORIGIN`, update the registered URI to match. [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
2. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the local `.env` file. Sign-in requires a verified `@illinois.edu` email and the `illinois.edu` Google Workspace domain. Each account sees its own agenda.
3. Set `OPENAI_API_KEY` in `.env` to enable live extraction. The default model is `gpt-4.1-mini`. If you set `OPENAI_MODEL`, use a model that supports PDF input and structured outputs. The server sends the uploaded PDF or pasted text to OpenAI for extraction. [OpenAI file inputs](https://developers.openai.com/api/docs/guides/file-inputs)
4. Run `npm run dev`, open [http://localhost:3000](http://localhost:3000), and click **Sign in with Google**.

Restart the server after editing `.env`. Git ignores `.env` and the local SQLite database at `data/deadlinehub.sqlite`.

## Test the three interactions

### 1. Sign in and open your agenda

Choose your `@illinois.edu` Google account. After Google redirects you back, **Course agenda** should appear. **Sign out** ends the application session. Sign in again with the same account to see its saved deadlines.

### 2. Import and review a syllabus

1. Click **Import syllabus**. Enter `CS 409` and set **Year for dates without one** to the year of the syllabus.
2. Choose **Paste text** and use the example below, or choose **Upload PDF** and select a syllabus PDF up to 5 MB. To test PDF extraction with the same example, print the sample text to a PDF and upload that file.
3. Click **Extract deadlines**. The example should produce two preview rows. Edit the first title or date, remove the second row, and click **Save 1 deadline**.
4. Confirm that the agenda contains the edited row with the selected course. Use **All courses** to filter by course.

```text
MP 4 is due November 20, 2026 at 11:59 PM.
The final exam is on December 4, 2026 at 1:30 PM.
```

### 3. Add a deadline in natural language

1. Click **Quick add** and enter `CS 409 MP due next Friday 11:59pm`.
2. Click **Preview deadline**. Check the resolved Friday and `11:59 PM` in Central Time. You can edit either field before saving.
3. Click **Save 1 deadline** and refresh the page to confirm the saved row is still there.

## Development checks

```sh
npm test
npm run build
```

The test suite covers the Google callback rules, account isolation, import preview and save behavior, and date parsing. After building, `npm start` serves the built application.
