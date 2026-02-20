/**
 * format-markdown plugin
 *
 * Transforms outgoing LLM responses from raw markdown into channel-appropriate
 * formatting. Self-contained — no external dependencies.
 *
 * Telegram: MarkdownV2 with proper escaping, box-drawn tables, bullet lists
 * Discord:  pass-through (native markdown)
 * WhatsApp: adapted markdown (*bold*, ~strike~, card-style tables)
 * Other:    plain text (strip all markdown)
 */

const TELEGRAM_SPECIAL = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

const TELEGRAM_TABLE_MAX_WIDTH = 60;

const BOX = {
    h: '\u2500', v: '\u2502',
    tl: '\u250C', tr: '\u2510', bl: '\u2514', br: '\u2518',
    lj: '\u251C', rj: '\u2524', tj: '\u252C', bj: '\u2534', cross: '\u253C',
};

function stripCellMarkdown(cell) {
    return cell
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '$1')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function parseAlignments(separator) {
    return separator.split('|').slice(1, -1).map(cell => {
        const trimmed = cell.trim();
        const left = trimmed.startsWith(':');
        const right = trimmed.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return 'left';
    });
}

function padAligned(s, width, align) {
    if (s.length >= width) return s;
    const gap = width - s.length;
    if (align === 'right') return ' '.repeat(gap) + s;
    if (align === 'center') {
        const left = Math.floor(gap / 2);
        return ' '.repeat(left) + s + ' '.repeat(gap - left);
    }
    return s + ' '.repeat(gap);
}

function truncate(s, max) {
    return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function convertMarkdownTables(text, channel) {
    const tableRegex = /^(\|.+\|)\n(\|[\s:|-]+\|)\n((?:\|.+\|\n?)+)/gm;

    return text.replace(tableRegex, (_match, headerLine, separator, bodyBlock) => {
        const parseRow = (row) =>
            row.split('|').slice(1, -1).map(cell => stripCellMarkdown(cell.trim()));

        const headers = parseRow(headerLine);
        const bodyRows = bodyBlock.trimEnd().split('\n').map(parseRow);
        const aligns = parseAlignments(separator);

        if (channel === 'telegram') {
            const numCols = headers.length;

            let colWidths = headers.map((h, i) =>
                Math.max(h.length, ...bodyRows.map(r => (r[i] || '').length))
            );

            const overhead = (numCols - 1) * 3 + 4;
            let totalWidth = colWidths.reduce((a, b) => a + b, 0) + overhead;

            if (totalWidth > TELEGRAM_TABLE_MAX_WIDTH) {
                const available = TELEGRAM_TABLE_MAX_WIDTH - overhead;
                const totalContent = colWidths.reduce((a, b) => a + b, 0);
                colWidths = colWidths.map(w => Math.max(2, Math.floor((w / totalContent) * available)));
            }

            const fmtHeaders = headers.map((h, i) => padAligned(truncate(h, colWidths[i]), colWidths[i], aligns[i] || 'left'));
            const fmtRows = bodyRows.map(r =>
                r.map((cell, i) => padAligned(truncate(cell, colWidths[i]), colWidths[i], aligns[i] || 'left'))
            );

            const topBorder    = BOX.tl + colWidths.map(w => BOX.h.repeat(w + 2)).join(BOX.tj) + BOX.tr;
            const headerDiv    = BOX.lj + colWidths.map(w => BOX.h.repeat(w + 2)).join(BOX.cross) + BOX.rj;
            const bottomBorder = BOX.bl + colWidths.map(w => BOX.h.repeat(w + 2)).join(BOX.bj) + BOX.br;

            const headerRow = BOX.v + fmtHeaders.map(h => ' ' + h + ' ').join(BOX.v) + BOX.v;
            const dataRows = fmtRows.map(r =>
                BOX.v + r.map(cell => ' ' + cell + ' ').join(BOX.v) + BOX.v
            );

            const table = [topBorder, headerRow, headerDiv, ...dataRows, bottomBorder].join('\n');
            return '\n```\n' + table + '\n```\n';
        }

        // WhatsApp / plaintext: card-style
        const cards = bodyRows.map(row =>
            headers.map((h, i) => `${h}: ${row[i] || ''}`).join('\n')
        );
        return '\n' + cards.join('\n\n') + '\n';
    });
}

// --- Telegram MarkdownV2 ---

function transformTelegramText(text) {
    let working = text;

    working = working.replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
    working = working.replace(/^---+$/gm, '');
    working = working.replace(/^[\t ]*[-*]\s+/gm, '\u2022 ');

    const tokens = [];
    const inlineRegex = /\*\*(.+?)\*\*|~~(.+?)~~|\[([^\]]+)\]\(([^)]+)\)|(?:https?:\/\/[^\s<>\[\]()]+)|(?<!\w)\*(.+?)\*(?!\w)|(?<!\w)_(.+?)_(?!\w)/g;

    let lastIdx = 0;
    let inlineMatch;

    while ((inlineMatch = inlineRegex.exec(working)) !== null) {
        if (inlineMatch.index > lastIdx) {
            tokens.push({ type: 'raw', text: working.slice(lastIdx, inlineMatch.index) });
        }

        if (inlineMatch[1] !== undefined) {
            tokens.push({ type: 'bold', text: inlineMatch[1] });
        } else if (inlineMatch[2] !== undefined) {
            tokens.push({ type: 'strike', text: inlineMatch[2] });
        } else if (inlineMatch[3] !== undefined) {
            tokens.push({ type: 'link', text: inlineMatch[3], url: inlineMatch[4] });
        } else if (inlineMatch[5] !== undefined) {
            tokens.push({ type: 'italic', text: inlineMatch[5] });
        } else if (inlineMatch[6] !== undefined) {
            tokens.push({ type: 'italic', text: inlineMatch[6] });
        } else if (inlineMatch[0].startsWith('http')) {
            tokens.push({ type: 'bare_url', text: inlineMatch[0] });
        }

        lastIdx = inlineMatch.index + inlineMatch[0].length;
    }

    if (lastIdx < working.length) {
        tokens.push({ type: 'raw', text: working.slice(lastIdx) });
    }

    const parts = [];
    for (const token of tokens) {
        const escaped = token.text.replace(TELEGRAM_SPECIAL, '\\$1');
        switch (token.type) {
            case 'raw':
                parts.push(escaped);
                break;
            case 'bold':
                parts.push('*' + escaped + '*');
                break;
            case 'italic':
                parts.push('_' + escaped + '_');
                break;
            case 'strike':
                parts.push('~' + escaped + '~');
                break;
            case 'bare_url': {
                const escapedDisplay = token.text.replace(TELEGRAM_SPECIAL, '\\$1');
                const escapedHref = token.text.replace(/([)\\])/g, '\\$1');
                parts.push('[' + escapedDisplay + '](' + escapedHref + ')');
                break;
            }
            case 'link': {
                const escapedUrl = (token.url || '').replace(/([)\\])/g, '\\$1');
                parts.push('[' + escaped + '](' + escapedUrl + ')');
                break;
            }
        }
    }

    return parts.join('');
}

function formatTelegram(text) {
    let preprocessed = convertMarkdownTables(text, 'telegram');

    const segments = [];
    let remaining = preprocessed;

    const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(remaining)) !== null) {
        if (match.index > lastIndex) {
            segments.push({ type: 'text', content: remaining.slice(lastIndex, match.index) });
        }
        segments.push({ type: 'code', content: match[2], lang: match[1] });
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < remaining.length) {
        segments.push({ type: 'text', content: remaining.slice(lastIndex) });
    }

    const finalSegments = [];
    for (const seg of segments) {
        if (seg.type !== 'text') {
            finalSegments.push(seg);
            continue;
        }

        const inlineCodeRegex = /`([^`\n]+)`/g;
        let inlineLastIndex = 0;
        let inlineMatch;

        while ((inlineMatch = inlineCodeRegex.exec(seg.content)) !== null) {
            if (inlineMatch.index > inlineLastIndex) {
                finalSegments.push({ type: 'text', content: seg.content.slice(inlineLastIndex, inlineMatch.index) });
            }
            finalSegments.push({ type: 'inline_code', content: inlineMatch[1] });
            inlineLastIndex = inlineMatch.index + inlineMatch[0].length;
        }

        if (inlineLastIndex < seg.content.length) {
            finalSegments.push({ type: 'text', content: seg.content.slice(inlineLastIndex) });
        }
    }

    const output = [];
    for (const seg of finalSegments) {
        if (seg.type === 'code') {
            const lang = seg.lang || '';
            output.push('```' + lang + '\n' + seg.content + '```');
        } else if (seg.type === 'inline_code') {
            output.push('`' + seg.content + '`');
        } else {
            output.push(transformTelegramText(seg.content));
        }
    }

    let result = output.join('');
    result = result.replace(/\n{3,}/g, '\n\n');
    return result.trim();
}

// --- WhatsApp ---

function formatWhatsApp(text) {
    let working = text;

    const codeBlocks = [];
    working = working.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, content) => {
        const ph = `CODEBLOCK${codeBlocks.length}ENDBLOCK`;
        codeBlocks.push({ placeholder: ph, content });
        return ph;
    });

    const inlineCodes = [];
    working = working.replace(/`([^`\n]+)`/g, (_match, content) => {
        const ph = `INLINECODE${inlineCodes.length}ENDINLINE`;
        inlineCodes.push({ placeholder: ph, content });
        return ph;
    });

    working = convertMarkdownTables(working, 'whatsapp');
    working = working.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
    working = working.replace(/^---+$/gm, '');
    working = working.replace(/^[\t ]*[-*]\s+/gm, '\u2022 ');
    working = working.replace(/\*\*(.+?)\*\*/g, '*$1*');
    working = working.replace(/~~(.+?)~~/g, '~$1~');
    working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    for (const ic of inlineCodes) {
        working = working.replace(ic.placeholder, '`' + ic.content + '`');
    }
    for (const cb of codeBlocks) {
        working = working.replace(cb.placeholder, '```' + cb.content + '```');
    }

    working = working.replace(/\n{3,}/g, '\n\n');
    return working.trim();
}

// --- Plaintext ---

function stripMarkdown(text) {
    let working = text;
    working = convertMarkdownTables(working, 'plaintext');
    working = working.replace(/```\w*\n?([\s\S]*?)```/g, '$1');
    working = working.replace(/`([^`\n]+)`/g, '$1');
    working = working.replace(/^#{1,6}\s+/gm, '');
    working = working.replace(/^---+$/gm, '');
    working = working.replace(/\*\*(.+?)\*\*/g, '$1');
    working = working.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '$1');
    working = working.replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');
    working = working.replace(/~~(.+?)~~/g, '$1');
    working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
    working = working.replace(/^[\t ]*[-*]\s+/gm, '\u2022 ');
    working = working.replace(/\n{3,}/g, '\n\n');
    return working.trim();
}

// --- Main formatting ---

function formatMarkdown(text, channel) {
    if (!text) return text;
    if (channel === 'discord') return text;
    if (channel === 'telegram') return formatTelegram(text);
    if (channel === 'whatsapp') return formatWhatsApp(text);
    return stripMarkdown(text);
}

// --- Plugin exports ---

module.exports.hooks = {
    transformOutgoing(message, ctx) {
        if (ctx.channel === 'telegram') {
            return { text: formatTelegram(message), metadata: { parseMode: 'MarkdownV2' } };
        }
        return formatMarkdown(message, ctx.channel);
    },
};
