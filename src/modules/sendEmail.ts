import nodemailer from "nodemailer";
import Mustache from "mustache";

export interface sendEmailInput {
  to: string | string[];
  html: string;
  subject: string;
}

/**
 * Send an email using Nodemailer via SMTP.
 *
 * Variables which can be used in subject and html:
 * {{platform.url}}
 * {{platform.name}}
 */
export default async function sendEmail({ to, subject, html }: sendEmailInput) {
  if (typeof to === "string") to = [to];

  if (!process.env.SMTP_HOST || !process.env.SMTP_PORT || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("SMTP configuration is missing");
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true", // true for port 465, false for others
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const enrichment = {};

  const mailOptions = {
    from: `"Champion Footballer" <notifications@championfootballer.com>`,
    to: to.join(", "),
    subject: Mustache.render(subject, enrichment),
    html: Mustache.render(html, enrichment),
  };

  await transporter.sendMail(mailOptions);
}


















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
