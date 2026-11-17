# DocuFlow - Cloud-Based Document Management and Approval System

DocuFlow is a web application for submitting documents, tracking their status, and making traceable approval decisions. It was built for the project **"Cloud-Based Document Management and Approval System Using AWS"**.

## What it does

- A user submits a file with their name and email address.
- Every submission begins as **Pending**.
- An admin dashboard lists all documents, supports download, and lets an administrator approve or reject with a note.
- The applicant portal shows all submissions for an email address and the full decision note.
- Every decision is kept in an approval-history record.

The default **local demo mode** is completely functional and needs no cloud account. It stores uploaded files in `uploads/` and metadata in `data/local-db.json`; it writes the simulated email notification to the server console.

## Quick start (local demo)

Prerequisites: Node.js 20 or newer.

```bash
npm install
cp .env.example .env
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Submit a file, select **Admin review**, approve or reject it, then select **My documents** and enter the original email address.

## Architecture

```text
Browser dashboard
       |
       v
EC2: Node.js / Express API
   |                  |
   v                  v
S3 private bucket    RDS PostgreSQL
files                users, documents, approvals
       \             /
        v           v
          SES email notification
               |
          CloudWatch logs/alarms
```

## AWS deployment design

1. Create a private S3 bucket with versioning and default encryption. Do not make it public.
2. Create a PostgreSQL RDS instance in private subnets. Run [`db/schema.sql`](db/schema.sql) on the database.
3. Launch an EC2 instance (or deploy the same Node service with Elastic Beanstalk) in a security group that can reach RDS. Configure an instance profile - never put AWS access keys in source control.
4. Verify a sender identity in Amazon SES. If your SES account is in the sandbox, verify recipient addresses too.
5. Set `APP_MODE=aws`, `AWS_REGION`, `S3_BUCKET`, `DATABASE_URL`, and `SES_FROM_EMAIL` in the deployment environment. Restrict IAM to the named S3 bucket, SES sending identity, and CloudWatch logging.
6. Add CloudWatch alarms for EC2 CPU, status-check failures, application 5xx responses, and RDS storage/connections.

> The supplied server runs the end-to-end local workflow by default and has a complete AWS adapter for S3, RDS PostgreSQL, signed download URLs, and SES. Set the listed AWS values only after provisioning the resources; this keeps the demo usable without unexpectedly incurring AWS charges.

### AWS SDK integration points

| Workflow | AWS action | Database action |
| --- | --- | --- |
| Upload | `PutObject` to `S3_BUCKET/documents/<uuid>` | Insert a `documents` row with S3 key and `pending` status |
| Open document | Generate short-lived `GetObject` signed URL | Read document metadata |
| Approve/reject | `SendEmail` through SES | Update document status; insert an `approvals` row in one transaction |

The `@aws-sdk/client-s3`, `@aws-sdk/client-ses`, and `pg` packages are already declared in `package.json` for this implementation work.

## Database model

- `users`: submitters and administrators.
- `documents`: file metadata, owner, S3 key, status, and timestamps.
- `approvals`: immutable decision history, reviewer, note, and timestamp.

## Security notes

- Validate file size and restrict accepted file types in production.
- Use presigned URLs rather than public S3 objects.
- Add real authentication and role checks before allowing public access to the admin routes.
- Keep RDS private, use TLS for the database, and store configuration in AWS Secrets Manager or Parameter Store.
- Enable S3 versioning, CloudTrail, and backups for an audit-ready deployment.

## Project layout

```text
public/       Responsive user and admin dashboards
server.js     API and local functional demo implementation
db/schema.sql PostgreSQL RDS schema
.env.example  Configuration template
```

## Team roles (suggested)

- **Backend & authentication:** EC2 service, APIs, login/roles.
- **Data & storage:** RDS schema, migrations, S3 private upload/download flow.
- **Frontend & notification:** dashboards, decision interface, SES templates.

## Verification

After starting the service, `GET /api/health` returns the active mode. Test the complete workflow by uploading a small PDF, making a decision in the admin dashboard, and confirming it appears with the decision note under the applicant email.
