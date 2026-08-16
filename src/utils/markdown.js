import { marked } from "marked";

marked.use({ breaks: true, gfm: true });

function makeLatexImg(mathCode, isSvg, type) {
  const fmt = isSvg ? "svg" : "gif";
  const prefix = String.raw`\dpi{110}\bg_white\space `;
  const src = `https://latex.codecogs.com/${fmt}.image?${encodeURIComponent(
    prefix + mathCode
  )}`;
  if (type === "block") {
    return `<br><img src="${src}" style="max-width:100%; border:none;" alt="Math block"><br>`;
  }
  return `<img src="${src}" style="vertical-align: middle; max-width:100%; border:none;" alt="Math inline">`;
}

function processLatexToPlaceholders(text, isSvg) {
  const placeholders = [];
  const placeholderBase = "%%LATEX_PLACEHOLDER_";
  text = String(text || "").replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => {
    const index = placeholders.length;
    placeholders.push(makeLatexImg(math.trim(), isSvg, "block"));
    return `${placeholderBase}${index}%%`;
  });
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => {
    const index = placeholders.length;
    placeholders.push(makeLatexImg(math.trim(), isSvg, "inline"));
    return `${placeholderBase}${index}%%`;
  });
  return { text, placeholders };
}

function restoreLatexPlaceholders(html, placeholders) {
  placeholders.forEach((imgTag, index) => {
    html = html.replace(`${"%%LATEX_PLACEHOLDER_"}${index}%%`, imgTag);
  });
  return html;
}

export async function renderMarkdownWithLatex(rawText, clientSupportsSvg) {
  const { text: textWithPlaceholders, placeholders } = processLatexToPlaceholders(
    rawText,
    clientSupportsSvg
  );
  const botHtml = await marked.parse(textWithPlaceholders);
  return restoreLatexPlaceholders(botHtml, placeholders);
}

