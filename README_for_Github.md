# Safa.ai

AI-powered film generation platform.

## Prerequisites

Make sure you have installed:

- Node.js 20+
- npm or pnpm
- Git
- PostgreSQL (if required by the project)

## Clone Repository

```bash
git clone https://github.com/mudasira1201/Safa.ai.git
cd Safa.ai
```

## Project Structure

```text
Safa.ai/
├── ai-film-pro/
├── safa-web/
└── ...
```

## Install Dependencies

### Frontend

```bash
cd safa-web
npm install
```

### AI Film Service

```bash
cd ../ai-film-pro
npm install
```

## Environment Variables

Create a `.env` file in the required folders.

Example:

```env
DATABASE_URL=
NEXTAUTH_SECRET=
OPENAI_API_KEY=
FAL_KEY=
STRIPE_SECRET_KEY=
```

Ask the project owner for the actual values.

## Database Setup

Run migrations:

```bash
npx prisma migrate deploy
```

Or for development:

```bash
npx prisma migrate dev
```

Generate Prisma client:

```bash
npx prisma generate
```

## Running the Application

### Frontend

```bash
cd safa-web
npm run dev
```

Runs on:

```text
http://localhost:3000
```

### Production Build

```bash
npm run build
npm start
```

## Git Workflow

Pull latest changes:

```bash
git pull origin main
```

Create a feature branch:

```bash
git checkout -b feature/feature-name
```

Push branch:

```bash
git push origin feature/feature-name
```

## Common Commands

Install packages:

```bash
npm install
```

Run lint:

```bash
npm run lint
```

Run build:

```bash
npm run build
```

## Team Access Steps

1. Get access to the GitHub repository.
2. Accept the GitHub invitation.
3. Clone the repository.
4. Add required environment variables.
5. Install dependencies.
6. Run database migrations.
7. Start the development server.

## Repository

https://github.com/mudasira1201/Safa.ai