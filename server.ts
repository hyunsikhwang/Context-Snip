import express from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import AdmZip from "adm-zip";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import iconv from "iconv-lite";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

// Handle pdf-lib with require to avoid ESM constructor issues
const pdflib = require("pdf-lib");
const PDFDocument = pdflib.PDFDocument;

// Handle different export patterns for pdf-parse
let pdf: any;
if (typeof pdfParse === 'function') {
  pdf = pdfParse;
} else if (pdfParse && typeof pdfParse.default === 'function') {
  pdf = pdfParse.default;
} else if (pdfParse && typeof pdfParse.pdf === 'function') {
  pdf = pdfParse.pdf;
} else if (pdfParse && pdfParse.__esModule && typeof pdfParse.default === 'function') {
  pdf = pdfParse.default;
} else {
  // Fallback: if it's an object, try to find any function property that might be the main entry
  pdf = pdfParse;
}

// Ensure it's a function before calling, or fallback to a dummy that logs
const safePdf = async (buffer: Buffer, options?: any) => {
  let callablePdf = pdf;
  
  // If not a function, check common properties again at runtime
  if (typeof callablePdf !== 'function' && callablePdf !== null && typeof callablePdf === 'object') {
    if (typeof callablePdf.default === 'function') callablePdf = callablePdf.default;
    else if (typeof callablePdf.pdf === 'function') callablePdf = callablePdf.pdf;
    else {
      // Last resort: find the first function in the object
      const firstFuncKey = Object.keys(callablePdf).find(key => typeof callablePdf[key] === 'function');
      if (firstFuncKey) callablePdf = callablePdf[firstFuncKey];
    }
  }

  if (typeof callablePdf !== 'function') {
    console.error("PDF library failure. Module structure:", JSON.stringify(Object.keys(pdfParse)));
    throw new Error("PDF library initialization failed: The loaded module is not a function.");
  }
  
  try {
    return await callablePdf(buffer, options);
  } catch (err) {
    console.error("pdf-parse error:", err);
    // Fallback: return empty text if pdf-parse fails
    return { text: "" };
  }
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // API Route to optimize PDF by extracting only relevant pages
  app.post("/api/optimize-pdf", async (req, res) => {
    const { base64, keywords } = req.body;
    if (!base64) {
      return res.status(400).json({ error: "Base64 data is required" });
    }

    try {
      const buffer = Buffer.from(base64, 'base64');
      
      // 1. Identify relevant pages using pdf-parse
      const pageScores = new Map<number, number>();
      const pageTexts = new Map<number, string>();
      const searchKeywords = keywords || [
        "보험금 예실차비율", 
        "지급여력비율", 
        "K-ICS", 
        "최적가정", 
        "공통적용 경과조치", 
        "손해율", 
        "가용자본", 
        "요구자본",
        "보험금예실차",
        "경과조치 전",
        "경과조치 후"
      ];
      
      // Optimization: Pre-compile regex for speed
      const keywordRegexes = searchKeywords.map(kw => 
        new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      );
      
      await safePdf(buffer, {
        pagerender: (pageData: any) => {
          return pageData.getTextContent().then((textContent: any) => {
            const text = textContent.items.map((item: any) => item.str).join(" ");
            pageTexts.set(pageData.pageIndex + 1, text);
            
            let score = 0;
            keywordRegexes.forEach((regex) => {
              const matches = text.match(regex);
              if (matches) score += matches.length;
            });
            
            if (score > 0) {
              pageScores.set(pageData.pageIndex + 1, score);
            }
            return text;
          });
        }
      });

      if (pageScores.size === 0) {
        return res.json({ base64, optimized: false, message: "No keywords found, returning original." });
      }

      // 2. Extract pages using pdf-lib
      const srcDoc = await PDFDocument.load(buffer);
      const pdfDoc = await PDFDocument.create();
      const totalPages = srcDoc.getPageCount();
      
      // Sort pages by score
      const sortedRelevantPages = Array.from(pageScores.entries())
        .sort((a, b) => b[1] - a[1]);
      
      if (sortedRelevantPages.length === 0) {
        return res.json({ base64, optimized: false, message: "No relevant content found." });
      }

      const maxScore = sortedRelevantPages[0][1];
      const pagesToExtract = new Set<number>();
      
      // Strategy: Take top 5 most relevant pages, but only if they have at least 20% of the max score
      // This filters out noise and focuses on the most likely table locations.
      const topPages = sortedRelevantPages
        .filter(entry => entry[1] >= maxScore * 0.2)
        .slice(0, 5)
        .map(entry => entry[0]);
      
      topPages.forEach(p => {
        const idx = p - 1;
        pagesToExtract.add(idx);
        // Add one page after (tables often span 2 pages)
        if (idx < totalPages - 1) pagesToExtract.add(idx + 1);
        // Context page before
        if (idx > 0) pagesToExtract.add(idx - 1);
      });

      // Limit to 10 pages total (Surgical selection saves ~33% tokens vs 15 pages)
      const finalPages = Array.from(pagesToExtract).sort((a, b) => a - b).slice(0, 10);
      
      // Collect text from final pages to check if it's searchable
      let combinedText = "";
      let totalKeywordScore = 0;
      finalPages.forEach(idx => {
        const text = pageTexts.get(idx + 1) || "";
        combinedText += text + "\n";
        totalKeywordScore += pageScores.get(idx + 1) || 0;
      });

      // Improved isScanned detection:
      // 1. Check total text length
      const textLength = combinedText.trim().length;
      // 2. Check alphanumeric ratio (to filter out garbage OCR)
      const alphaNumCount = combinedText.replace(/[^a-zA-Z0-9가-힣]/g, "").length;
      const alphaNumRatio = textLength > 0 ? alphaNumCount / textLength : 0;
      // 3. Check word count
      const wordCount = combinedText.trim().split(/\s+/).filter(w => w.length > 1).length;

      // A PDF is considered searchable (NOT scanned) if:
      // - It has enough meaningful text (length > 300 and alphaNumRatio > 0.5)
      // - OR it has very strong keyword matches (totalKeywordScore > 3)
      const isSearchable = (textLength > 300 && alphaNumRatio > 0.5 && wordCount > 50) || (totalKeywordScore > 3);
      const isScanned = !isSearchable;

      console.log(`PDF Detection [${isScanned ? "SCANNED" : "SEARCHABLE"}]: Length=${textLength}, Ratio=${alphaNumRatio.toFixed(2)}, Words=${wordCount}, Score=${totalKeywordScore}`);

      const copiedPages = await pdfDoc.copyPages(srcDoc, finalPages);
      copiedPages.forEach(page => pdfDoc.addPage(page));

      const optimizedPdfBytes = await pdfDoc.save();
      const optimizedBase64 = Buffer.from(optimizedPdfBytes).toString('base64');

      res.json({ 
        base64: optimizedBase64, 
        optimized: true, 
        isScanned,
        extractedText: isScanned ? null : combinedText,
        originalPageCount: totalPages,
        optimizedPageCount: finalPages.length,
        extractedPages: finalPages.map(p => p + 1)
      });
    } catch (error: any) {
      console.error("PDF optimization error:", error);
      // Fallback to original if optimization fails
      res.json({ base64, optimized: false, error: error.message });
    }
  });

  // API Route to extract text from PDF base64
  app.post("/api/extract-text", async (req, res) => {
    const { base64 } = req.body;
    if (!base64) {
      return res.status(400).json({ error: "Base64 data is required" });
    }

    try {
      const buffer = Buffer.from(base64, 'base64');
      const data = await safePdf(buffer);
      res.json({ text: data.text });
    } catch (error: any) {
      console.error("PDF text extraction error:", error);
      res.status(500).json({ error: `Failed to extract text: ${error.message}` });
    }
  });

  // API Route to fetch PDF from URL and return as base64
  app.get("/api/fetch-pdf", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }

    try {
      const urlObj = new URL(url);
      
      // Special handling for knia.or.kr which might be sensitive to Referer
      let referer = urlObj.origin;
      let origin = urlObj.origin;
      if (url.includes("knia.or.kr")) {
        referer = "https://kpub.knia.or.kr/mngtDis/mngtDis/list.do";
        origin = "https://kpub.knia.or.kr";
      }

      const response = await axios.get(url, {
        responseType: "arraybuffer",
        maxRedirects: 10,
        timeout: 120000, // Increase to 120 seconds
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
          "Accept-Encoding": "identity", // Avoid compression issues
          "Referer": referer,
          "Origin": origin,
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
          "Upgrade-Insecure-Requests": "1",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-User": "?1",
          "Connection": "keep-alive"
        },
        validateStatus: (status) => status >= 200 && status < 400,
      });

      const dataBuffer = Buffer.from(response.data);
      
      // Log response info for debugging
      console.log(`Response from ${url}: Status ${response.status}, Content-Type: ${response.headers['content-type']}, Length: ${dataBuffer.length}`);

      // More robust magic number checks
      // PDFs usually start with %PDF-, but some might have leading whitespace or garbage
      const pdfHeader = "%PDF-";
      const headString = dataBuffer.slice(0, 1024).toString("binary");
      const isPdfMagic = headString.includes(pdfHeader);
                         
      const isZipMagic = dataBuffer.length >= 4 && 
                         dataBuffer[0] === 0x50 && // P
                         dataBuffer[1] === 0x4B && // K
                         dataBuffer[2] === 0x03 && // \x03
                         dataBuffer[3] === 0x04;   // \x04

      const files = [];

      if (isZipMagic) {
        try {
          const zip = new AdmZip(dataBuffer);
          const zipEntries = zip.getEntries();
          
          const targetFiles = [];
          const allPdfFiles = [];
          
          for (const entry of zipEntries) {
            if (entry.isDirectory) continue;

            // Robust raw name extraction
            let rawName: Buffer;
            if (Buffer.isBuffer((entry as any).rawEntryName)) {
              rawName = (entry as any).rawEntryName;
            } else if (Buffer.isBuffer((entry as any).header?.fileName)) {
              rawName = (entry as any).header.fileName;
            } else {
              // Fallback: try to recover from binary string
              rawName = Buffer.from(entry.entryName, 'binary');
            }
            
            // Try decodings
            const decodedUtf8 = iconv.decode(rawName, 'utf8');
            const decodedCp949 = iconv.decode(rawName, 'cp949');
            const decodedEucKr = iconv.decode(rawName, 'euc-kr');
            
            // RFC 2047 decoding for ZIP entries (rare but possible)
            const decodeMimeEncodedString = (str: string) => {
              const match = str.match(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/i);
              if (match) {
                const [_, charset, encoding, data] = match;
                if (encoding.toUpperCase() === 'B') {
                  const buffer = Buffer.from(data, 'base64');
                  return iconv.decode(buffer, charset);
                } else if (encoding.toUpperCase() === 'Q') {
                  // Simple Quoted-Printable decoder for RFC 2047
                  const decoded = data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, hex) => {
                    return String.fromCharCode(parseInt(hex, 16));
                  });
                  return iconv.decode(Buffer.from(decoded, 'binary'), charset);
                }
              }
              return str;
            };

            const decodings = [
              decodedUtf8,
              decodedCp949,
              decodedEucKr,
              decodeMimeEncodedString(entry.entryName),
              entry.entryName
            ];

            const hasKorean = (str: string) => /[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(str);
            
            // Priority for bestName:
            // 1. Any decoding that contains "경영공시"
            // 2. Any decoding that contains "공시"
            // 3. Any decoding that contains Korean characters (prefer CP949 if multiple)
            
            let bestName = entry.entryName;
            const targetKeyword = "경영공시";
            
            const matchTarget = decodings.find(d => d.includes(targetKeyword));
            const matchGongsi = decodings.find(d => d.includes("공시"));
            
            // Prefer CP949 or EUC-KR if they have Korean characters
            const matchKorean = [decodedCp949, decodedEucKr, decodedUtf8, decodings[3]].find(d => hasKorean(d));
            
            if (matchTarget) {
              bestName = matchTarget;
            } else if (matchGongsi) {
              bestName = matchGongsi;
            } else if (matchKorean) {
              bestName = matchKorean;
            } else {
              bestName = decodings.find(d => d.toLowerCase().endsWith(".pdf")) || entry.entryName;
            }

            const isPdf = bestName.toLowerCase().endsWith(".pdf");
            const isTarget = bestName.includes(targetKeyword);

            const entryData = entry.getData();
            const fileObj = {
              base64: entryData.toString("base64"),
              mimeType: "application/pdf",
              name: path.basename(bestName)
            };

            if (isPdf) {
              allPdfFiles.push(fileObj);
              if (isTarget) {
                targetFiles.push(fileObj);
              }
            }
          }
          
          // Strict filtering: 
          // 1. If "경영공시" matches exist, ONLY return those.
          // 2. Otherwise, if "공시" matches exist, ONLY return those.
          // 3. Otherwise, if any PDFs exist, return them (up to 5).
          let finalFiles = [];
          if (targetFiles.length > 0) {
            finalFiles = targetFiles;
          } else {
            const gongsiMatches = allPdfFiles.filter(f => f.name.includes("공시"));
            if (gongsiMatches.length > 0) {
              finalFiles = gongsiMatches;
            } else {
              // Only fallback to all PDFs if absolutely no keywords match
              // Limit to 5 to avoid "모든 파일" issue
              finalFiles = allPdfFiles.slice(0, 5);
            }
          }

          if (finalFiles.length === 0) {
            return res.status(400).json({ error: "ZIP 파일 내에 PDF 파일을 찾을 수 없습니다." });
          }
          
          files.push(...finalFiles);
        } catch (zipError) {
          console.error("ZIP extraction error:", zipError);
          return res.status(500).json({ error: "ZIP 파일의 압축을 푸는 중 오류가 발생했습니다." });
        }
      } else {
        const base64 = dataBuffer.toString("base64");
        
        // Normalize MIME type for Gemini API
        let mimeType = response.headers["content-type"] || "application/pdf";
        
        if (isPdfMagic || mimeType.includes("application/octet-stream") || mimeType.includes("pdf") || url.toLowerCase().endsWith(".pdf") || url.toLowerCase().endsWith(".do")) {
          mimeType = "application/pdf";
        } else {
          // Strip charset if present
          mimeType = mimeType.split(";")[0].trim();
        }

        // If it's not a PDF but we forced it, check if it's actually HTML (error page)
        if (mimeType === "application/pdf" && !isPdfMagic) {
          const textSample = dataBuffer.slice(0, 100).toString().toLowerCase();
          if (textSample.includes("<!doctype html") || textSample.includes("<html")) {
            return res.status(400).json({ error: "The URL returned an HTML page instead of a PDF file. This might be a landing page or an error page." });
          }
        }
        
        let fileName = "download.pdf";
        const contentDisposition = response.headers["content-disposition"];
        
        if (contentDisposition) {
          // RFC 2047 decoding function
          const decodeMimeEncodedString = (str: string) => {
            const match = str.match(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/i);
            if (match) {
              const [_, charset, encoding, data] = match;
              if (encoding.toUpperCase() === 'B') {
                const buffer = Buffer.from(data, 'base64');
                return iconv.decode(buffer, charset);
              } else if (encoding.toUpperCase() === 'Q') {
                // Simple Quoted-Printable decoder for RFC 2047
                const decoded = data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, hex) => {
                  return String.fromCharCode(parseInt(hex, 16));
                });
                return iconv.decode(Buffer.from(decoded, 'binary'), charset);
              }
            }
            return str;
          };

          // Improved regex to handle filename and filename*
          // Use word boundaries or specific prefixes to avoid filename matching filename*
          const filenameStarRegex = /[; ]filename\*=((['"]).*?\2|[^;\n]*)/i;
          const filenameRegex = /[; ]filename=((['"]).*?\2|[^;\n]*)/i;
          
          // Add a leading space to contentDisposition to make regex matching easier for the first parameter
          const cd = " " + contentDisposition;
          
          const starMatches = filenameStarRegex.exec(cd);
          const normalMatches = filenameRegex.exec(cd);
          
          if (starMatches && starMatches[1]) {
            let starName = starMatches[1].replace(/['"]/g, '');
            // Handle UTF-8''... or EUC-KR''...
            const encodingMatch = starName.match(/^([^']+)''(.+)$/i);
            if (encodingMatch) {
              const [_, charset, encodedData] = encodingMatch;
              try {
                const decoded = decodeURIComponent(encodedData);
                // If it's not UTF-8, we might need iconv
                if (charset.toUpperCase() !== 'UTF-8') {
                  const buffer = Buffer.from(decoded, 'binary');
                  fileName = iconv.decode(buffer, charset);
                } else {
                  fileName = decoded;
                }
              } catch (e) {
                fileName = starName;
              }
            } else {
              fileName = starName;
            }
          } else if (normalMatches && normalMatches[1]) {
            fileName = normalMatches[1].replace(/['"]/g, '');
            
            // Handle RFC 2047
            if (fileName.includes('=?')) {
              fileName = decodeMimeEncodedString(fileName);
            } else {
              try {
                // Try to decode if it's potentially broken Korean (binary string)
                const buffer = Buffer.from(fileName, 'binary');
                const decodedUtf8 = iconv.decode(buffer, 'utf-8');
                const decodedCp949 = iconv.decode(buffer, 'cp949');
                const decodedEucKr = iconv.decode(buffer, 'euc-kr');
                
                if (/[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(decodedUtf8)) {
                  fileName = decodedUtf8;
                } else if (/[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(decodedCp949)) {
                  fileName = decodedCp949;
                } else if (/[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/.test(decodedEucKr)) {
                  fileName = decodedEucKr;
                } else {
                  // Fallback to URL decoding if possible
                  // Handle '+' as space which is common in some legacy systems
                  const urlDecoded = decodeURIComponent(fileName.replace(/\+/g, ' '));
                  if (urlDecoded !== fileName) {
                    fileName = urlDecoded;
                  }
                }
              } catch (e) {
                // Fallback to original fileName
              }
            }
          }
        } else {
          try {
            const lastPart = url.split("/").pop() || "";
            fileName = decodeURIComponent(lastPart.split("?")[0]) || "download.pdf";
          } catch (e) {
            // Fallback
          }
        }

        if (!fileName.toLowerCase().endsWith(".pdf")) {
          fileName += ".pdf";
        }

        files.push({
          base64,
          mimeType,
          name: fileName
        });
      }

      res.json({ files });
    } catch (error: any) {
      // Improved error logging: avoid printing the whole Axios error object
      const errorMessage = error.response ? `HTTP ${error.response.status}` : error.message || String(error);
      console.error(`Error fetching PDF from ${url}:`, errorMessage);
      
      if (error.code === 'ECONNABORTED' || error.message?.includes('aborted')) {
        return res.status(504).json({ error: "The request timed out or was aborted by the server. Please try again." });
      }
      
      res.status(500).json({ error: `Failed to fetch PDF: ${errorMessage}` });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
