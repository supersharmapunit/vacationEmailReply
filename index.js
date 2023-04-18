const fs = require('fs').promises;
const path = require('path');
const process = require('process');
const { authenticate } = require('@google-cloud/local-auth');
const { google } = require('googleapis');
const base64url = require('base64url');
const fsr = require('fs');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

/**
 * Reads previously authorized credentials from the save file.
 *
 * @return {Promise<OAuth2Client|null>}
 */
async function loadSavedCredentialsIfExist() {
    try {
        const content = await fs.readFile(TOKEN_PATH);
        const credentials = JSON.parse(content);
        return google.auth.fromJSON(credentials);
    } catch (err) {
        return null;
    }
}

/**
 * Serializes credentials to a file compatible with GoogleAUth.fromJSON.
 *
 * @param {OAuth2Client} client
 * @return {Promise<void>}
 */
async function saveCredentials(client) {
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    });
    await fs.writeFile(TOKEN_PATH, payload);
}

/**
 * Load or request or authorization to call APIs.
 *
 */
async function authorize() {
    let client = await loadSavedCredentialsIfExist();
    if (client) {
        return client;
    }
    client = await authenticate({
        scopes: SCOPES,
        keyfilePath: CREDENTIALS_PATH,
    });
    if (client.credentials) {
        await saveCredentials(client);
    }
    return client;
}

async function createMessage(auth, subject, message) {
    try {
        const gmail = google.gmail({ version: 'v1', auth });
        const utf8Subject = `=?utf-8?B?${base64url(Buffer.from(subject))}?=`;

        const messageParts = [
            `To: punit2000sharma@gmail.com`,
            `Subject: ${utf8Subject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            message
        ];
        const messageText = messageParts.join('\n');
        const encodedMessage = base64url(Buffer.from(messageText));
        const res = await gmail.users.messages.send({
            requestBody: {
                raw: encodedMessage,
            },
            userId: 'me',
        });
        console.log('Message sent:', res.data);
    } catch (err) {
        console.error('Error sending message:', err);
    }
}

async function addLabel(auth, messageId, labelId) {
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
            addLabelIds: [labelId],
        },
    });
}

async function sendReply(auth, messageId) {
    // check if the email has already been replied to and labeled
    let repliedIds = getRepliedIds();
    if (repliedIds.toString().includes(messageId.toString())) {
        console.log(`Message ${messageId} already replied to`);
        return;
    }
    

    const gmail = google.gmail({ version: 'v1', auth });
    const thread = await gmail.users.threads.get({ userId: 'me', id: messageId });
    const message = thread.data.messages[0];
    const headers = message.payload.headers;
    let to = '';
    for (let i = 0; i < headers.length; i++) {
        if (headers[i].name === 'From') {
            to = headers[i].value.split(' ')[1].replace('<', '').replace('>', '');
            break;
        }
    }
    const subject = message.payload.headers.find(({ name }) => name === 'Subject').value;
    const label = 'UNREAD';
    await gmail.users.messages.modify({
        userId: 'me',
        id: message.id,
        requestBody: {
            addLabelIds: [label],
            removeLabelIds: ['INBOX']
        }
    });
    const messageParts = [
        `Dear ${to.split('@')[0]},`,
        '',
        `Thank you for contacting us regarding ${subject}. We appreciate your interest.`,
        '',
        'Best regards,',
        'The Support Team'
    ];
    const messageText = messageParts.join('\n');
    await createMessage(auth, to, `Re: ${subject}`, messageText);
    addLabelToEmail(auth, messageId);
    console.log('Reply sent to:', to);
    
    repliedIds.push(message.id);
    fsr.writeFileSync('./repliedIds.json', JSON.stringify(repliedIds, null, 2));
}

function getRepliedIds() {
    try {
        const data = fsr.readFileSync('./repliedIds.json', "utf-8");
        return JSON.parse(data);
    } catch (err) {
        console.log('No replied IDs found');
        return [];
    }
}

async function checkForNewEmails(auth, labelId) {
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.messages.list({
        userId: 'me',
        labelIds: [labelId],
    });
    const messages = res.data.messages || [];
    return messages;
}

const LABEL_NAME = 'UNREAD';

async function main() {
    const auth = await authorize();
    const gmail = google.gmail({ version: 'v1', auth });

    // Create label if it does not exist
    let labelId;
    const res = await gmail.users.labels.list({ userId: 'me' });
    const labels = res.data.labels || [];
    const label = labels.find((l) => l.name === LABEL_NAME);
    if (label) {
        labelId = label.id;
        console.log(`Using existing label "${LABEL_NAME}" with ID ${labelId}`);
    } else {
        const res = await gmail.users.labels.create({
            userId: 'me',
            requestBody: {
                name: LABEL_NAME,
                labelListVisibility: 'labelShow',
                messageListVisibility: 'show',
            },
        });
        labelId = res.data.id;
        console.log(`Created new label "${LABEL_NAME}" with ID ${labelId}`);
    }

    while (true) {
        const messages = await checkForNewEmails(auth, labelId);
        console.log(`Found ${messages.length} new messages`);
        for (const message of messages) {
            const messageId = message.id;
            const threadId = message.threadId;

            // Check if message is a reply
            const res = await gmail.users.messages.get({
                userId: 'me',
                id: messageId,
                format: 'metadata',
                metadataHeaders: ['References', 'In-Reply-To'],
            });
            const headers = res.data.payload.headers || [];
            const isReply = headers.some(
                (h) =>
                    h.name.toLowerCase() === 'in-reply-to' ||
                    h.name.toLowerCase() === 'references'
            );
            if (isReply) {
                console.log(`Skipping reply message ${messageId}`);
                continue;
            }

            const messageText = 'Hello, thank you for your email!';
            await sendReply(auth, threadId, messageText, labelId);
            console.log(`Sent reply message to thread ${threadId}`);

            await addLabel(auth, messageId, labelId);
            console.log(`Added label "${LABEL_NAME}" to message ${messageId}`);
        }

        const interval = Math.floor(Math.random() * (120 - 45 + 1) + 45);
        console.log(`Waiting for ${interval} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    }
}

main().catch(console.error);


async function addLabelToEmail(auth, messageId, labelName = "REPLIED") {
    const gmail = google.gmail({ version: 'v1', auth });
    let labelId;

    // Get the label ID for the given label name, or create the label if it does not exist
    try {
        const res = await gmail.users.labels.list({ userId: 'me' });
        const labels = res.data.labels;
        const label = labels.find(l => l.name === labelName);
        if (label) {
            labelId = label.id;
        } else {
            const newLabelRes = await gmail.users.labels.create({
                userId: 'me',
                requestBody: {
                    name: labelName,
                    labelListVisibility: 'labelShow',
                    messageListVisibility: 'show',
                },
            });
            labelId = newLabelRes.data.id;
        }
    } catch (error) {
        console.error('Error retrieving or creating label', error);
        throw error;
    }

    // Modify the label of the given email to include the new label, and remove the "INBOX" label
    try {
        const modifyRes = await gmail.users.messages.modify({
            userId: 'me',
            id: messageId,
            addLabelIds: [labelId],
            removeLabelIds: ['INBOX'],
        });
        console.log(`Added label "${labelName}" to message: ${messageId}`);
        return modifyRes;
    } catch (error) {
        console.error(`Error adding label "${labelName}" to message: ${messageId}`, error);
        throw error;
    }
}
