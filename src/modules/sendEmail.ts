import nodemailer, { Transporter } from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const {
  SMTP_HOST,
  SMTP_USER,
  SMTP_PASS,
} = process.env;

// Ensure environment variables are defined (optional but recommended)
// if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
//   throw new Error('Missing required email environment variables');
// }


// Create transporter with SMTP config
const transporter: Transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: 465,
  secure: true,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

// Verify connection configuration
transporter.verify((error: Error | null, success: boolean) => {
  if (error) {
    console.error('Error connecting to SMTP server:', error);
  } else {
    console.log('SMTP server is ready to send emails:', success);
  }
});

// Define type for mail options
type MailOptions = {
  to: string;
  subject: string;
  htmlContent: string;
};

export const createMailOptions = ({ to, subject, htmlContent }: MailOptions) => {
  return {
    from: SMTP_USER,
    to,
    subject,
    html: htmlContent,
  };
};

export { transporter };



















// import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses"
// import Mustache from "mustache"

// export interface sendEmailInput {
//   /** An email address or list of addresses */
//   to: string | string[]
//   /** HTML body of email */
//   html: string
//   /** Email subject */
//   subject: string
// }

// /**
//  * Send an email using AWS SES.
//  *
//  * Variables which can be used in subject and html:
//  * {{platform.url}}
//  * {{platform.name}}
//  */
// export default async function sendEmail({ to, subject, html }: sendEmailInput) {
//   if (typeof to === "string") to = [to]

//   if (!process.env.CF_AWS_ACCESS_KEY_ID || !process.env.CF_AWS_SECRET_ACCESS_KEY) {
//     throw new Error('AWS credentials are not configured');
//   }

//   const client = new SESClient({
//     region: "us-east-1",
//     credentials: {
//       accessKeyId: process.env.CF_AWS_ACCESS_KEY_ID,
//       secretAccessKey: process.env.CF_AWS_SECRET_ACCESS_KEY,
//     },
//   })

//   // Send email

//   const source = `Champion Footballer <notifications@championfootballer.com>`

//   const enrichment = {}

//   const params = {
//     Destination: {
//       ToAddresses: to,
//     },
//     Message: {
//       Body: {
//         Html: {
//           Charset: "UTF-8",
//           Data: Mustache.render(html, enrichment),
//         },
//       },
//       Subject: {
//         Charset: "UTF-8",
//         Data: Mustache.render(subject, enrichment),
//       },
//     },
//     Source: source,
//     ReplyToAddresses: to,
//   }

//   const sendEmailCommand = new SendEmailCommand(params)
//   await client.send(sendEmailCommand)
// }
