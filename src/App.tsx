/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef } from "react";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { FileUp, FileText, Loader2, Table as TableIcon, AlertCircle, HelpCircle, Download, Trash2, Cpu, Zap } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Initialize Gemini AI
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

interface FileData {
  name: string;
  base64: string;
  mimeType: string;
}

export default function App() {
  const [files, setFiles] = useState<FileData[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [isExtracting, setIsExtracting] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [extractedTable, setExtractedTable] = useState<string | null>(null);
  const [extractedSolvencyTable, setExtractedSolvencyTable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorLog, setErrorLog] = useState<string[]>([]);
  const [processingStatus, setProcessingStatus] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("gemini-3-flash-preview");
  const [usageStats, setUsageStats] = useState<{
    totalTokens: number;
    promptTokens: number;
    candidatesTokens: number;
    cost: number;
    startTime: number | null;
    endTime: number | null;
  }>({
    totalTokens: 0,
    promptTokens: 0,
    candidatesTokens: 0,
    cost: 0,
    startTime: null,
    endTime: null
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClear = () => {
    setFiles([]);
    setUrlInput("");
    setExtractedTable(null);
    setExtractedSolvencyTable(null);
    setError(null);
    setErrorLog([]);
    setProcessingStatus(null);
    setUsageStats({
      totalTokens: 0,
      promptTokens: 0,
      candidatesTokens: 0,
      cost: 0,
      startTime: null,
      endTime: null
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const copyToClipboardAsTsv = (markdown: string) => {
    const lines = markdown.trim().split('\n');
    const tsvLines = lines
      .map(line => line.trim())
      .filter(line => line.startsWith('|') && line.endsWith('|'))
      .filter(line => !line.match(/^\|?\s*:?-+:?\s*(\|?\s*:?-+:?\s*)*\|?$/))
      .map(line => {
        const cells = line.slice(1, -1).split('|');
        return cells.map(cell => cell.trim()).join('\t');
      });
    
    const tsvString = tsvLines.join('\n');
    navigator.clipboard.writeText(tsvString);
    alert("Excel에 붙여넣기 좋은 형식(Tab 구분)으로 복사되었습니다.");
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;

    setIsExtracting(true);
    setError(null);
    
    const newFiles: FileData[] = [];
    
    try {
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        if (file.type !== "application/pdf") {
          continue;
        }

        const reader = new FileReader();
        const base64Promise = new Promise<{ data: string; mimeType: string }>((resolve, reject) => {
          reader.onload = () => {
            const result = reader.result as string;
            const commaIndex = result.indexOf(',');
            resolve({
              data: result.substring(commaIndex + 1),
              mimeType: file.type || "application/octet-stream"
            });
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const { data: base64Data, mimeType } = await base64Promise;
        newFiles.push({
          name: file.name,
          base64: base64Data,
          mimeType: mimeType,
        });
      }

      if (newFiles.length > 0) {
        setFiles((prev) => [...prev, ...newFiles]);
        // Trigger extraction immediately as per user's pattern
        await extractSequentially(newFiles);
      }
    } catch (err: any) {
      setError(err.message || "문서 처리 중 오류가 발생했습니다. 다시 시도해주세요.");
      console.error(err);
    } finally {
      setIsExtracting(false);
    }
  };

  const fetchPdfFromUrl = async () => {
    const urls = urlInput.split('\n').map(u => u.trim()).filter(u => u !== "");
    if (urls.length === 0) {
      setError("URL을 입력해주세요.");
      return;
    }

    setIsFetching(true);
    setError(null);
    const fetchedFiles: FileData[] = [];

    try {
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        setProcessingStatus(`파일 가져오는 중 (${i + 1}/${urls.length})...`);
        
        try {
          const response = await fetch(`/api/fetch-pdf?url=${encodeURIComponent(url)}`);
          
          let data;
          const contentType = response.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            data = await response.json();
          } else {
            const text = await response.text();
            console.error("Non-JSON response received:", text.substring(0, 200));
            throw new Error("서버에서 올바르지 않은 응답(HTML)을 받았습니다. 사이트 접근이 차단되었거나 세션이 만료되었을 수 있습니다.");
          }

          if (!response.ok) {
            throw new Error(data.error || "파일을 가져오는데 실패했습니다.");
          }

          if (data.files && Array.isArray(data.files)) {
            fetchedFiles.push(...data.files);
            setFiles((prev) => [...prev, ...data.files]);
          }
        } catch (err: any) {
          console.error(`Error fetching ${url}:`, err);
          const msg = `[URL 가져오기 실패] ${url}: ${err.message}`;
          setErrorLog(prev => [...prev, msg]);
          setError(`URL(${url})에서 파일을 가져오지 못했습니다.`);
        }
      }

      setUrlInput("");
      
      // After fetching all, if we have new files, start extraction sequentially
      if (fetchedFiles.length > 0) {
        await extractSequentially(fetchedFiles);
      }
    } finally {
      setIsFetching(false);
      setProcessingStatus(null);
    }
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const extractSequentially = async (targetFiles: FileData[]) => {
    setIsExtracting(true);
    setError(null);
    const startTime = Date.now();
    setUsageStats(prev => ({ ...prev, startTime, endTime: null }));
    
    let totalPromptTokens = 0;
    let totalCandidatesTokens = 0;

    const updateUsage = (response: any) => {
      if (response.usageMetadata) {
        const p = response.usageMetadata.promptTokenCount || 0;
        const c = response.usageMetadata.candidatesTokenCount || 0;
        totalPromptTokens += p;
        totalCandidatesTokens += c;
        
        // Pricing based on model (Gemini 3 series)
        // Flash: Input $0.075/1M, Output $0.30/1M
        // Flash Lite: Input $0.01/1M, Output $0.03/1M
        let inputRate = 0.000000075; 
        let outputRate = 0.00000030;
        
        if (selectedModel.includes("lite")) {
          inputRate = 0.00000001;
          outputRate = 0.00000003;
        }
        
        const currentCost = (totalPromptTokens * inputRate) + (totalCandidatesTokens * outputRate);
        
        setUsageStats(prev => ({
          ...prev,
          promptTokens: totalPromptTokens,
          candidatesTokens: totalCandidatesTokens,
          totalTokens: totalPromptTokens + totalCandidatesTokens,
          cost: currentCost
        }));
      }
    };
    
    try {
      for (let i = 0; i < targetFiles.length; i++) {
        let file = targetFiles[i];
        
        // --- 0. Optimize PDF (Extract relevant pages) ---
        try {
          setProcessingStatus(`PDF 최적화 중 (${i + 1}/${targetFiles.length}): ${file.name}`);
          const optRes = await fetch("/api/optimize-pdf", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              base64: file.base64,
              keywords: ["보험금 예실차비율", "지급여력비율", "K-ICS", "최적가정", "경과조치", "경영지표"]
            })
          });
          
          if (optRes.ok) {
            const optData = await optRes.json();
            if (optData.optimized) {
              console.log(`Optimized ${file.name}: ${optData.originalPageCount} pages -> ${optData.optimizedPageCount} pages (${optData.extractedPages.join(", ")})`);
              file = {
                ...file,
                base64: optData.base64
              };
            }
          }
        } catch (optErr) {
          console.error("Optimization failed, continuing with original:", optErr);
        }

        // --- 1. Extract Loss Ratio Data ---
        try {
          setProcessingStatus(`손해율 데이터 추출 중 (${i + 1}/${targetFiles.length}): ${file.name}`);

          const model = selectedModel;
          
          const prompt = `업로드된 PDF 파일 내용 중 '4-6-4) 최적가정 - ① 보험금 예실차비율' 에 있는 테이블을 아래의 layout 으로 추출해서 출력해주세요. 
[주의사항]
1. 반드시 마크다운 테이블 형식으로만 출력하세요.
2. 테이블 외의 어떠한 설명, 인사말, 주석, 분석 메시지도 포함하지 마세요. 오직 테이블 데이터만 출력하세요.
3. 테이블 주석 등의 내용은 생략해주세요.
4. 숫자 뒤의 '%' 기호는 모두 제거하고 숫자만 출력하세요. (예: 12.3% -> 12.3)
5. 수치 데이터에서 "+" 기호는 제거하세요. (예: +1.2 -> 1.2)
6. 괄호로 표시된 음수(예: (1.2))는 마이너스 기호로 변환하세요. (예: (1.2) -> -1.2)
7. '구분(연도)' 컬럼에서 숫자 뒤의 '년' 문자는 제거하고 숫자만 출력하세요. (예: 2023년 -> 2023)

[table layout]
|구분(연도)|회사명|예상손해율|실제손해율|보험금예실차비율|`;

          const contents = [
            {
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    data: file.base64,
                    mimeType: file.mimeType,
                  },
                },
              ],
            },
          ];

          let response;
          try {
            response = await genAI.models.generateContent({
              model,
              contents,
              config: {
                systemInstruction: "You are a data extraction specialist. Extract only the requested table data in markdown format. Do not provide any conversational text, explanations, or metadata. Be precise and concise.",
                thinkingConfig: {
                  thinkingLevel: model.includes("lite") ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW,
                },
                maxOutputTokens: 16384,
              },
            });
            updateUsage(response);
          } catch (apiErr: any) {
            const errMessage = apiErr.message || (apiErr.error?.message) || String(apiErr);
            const errStr = JSON.stringify(apiErr);
            console.log("Gemini API Error details (Loss Ratio):", { errMessage, errStr });

            if (errMessage.includes("token") || errMessage.includes("limit") || errMessage.includes("1048576") || errMessage.includes("INVALID_ARGUMENT") || errStr.includes("token") || errStr.includes("limit") || errStr.includes("1048576") || errStr.includes("INVALID_ARGUMENT")) {
              setProcessingStatus(`토큰 초과 (손해율): ${file.name} (텍스트 추출 모드)`);
              const textRes = await fetch("/api/extract-text", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ base64: file.base64 })
              });
              if (!textRes.ok) throw apiErr;
              const textData = await textRes.json();
              if (textData.text) {
                response = await genAI.models.generateContent({
                  model,
                  contents: [{ parts: [{ text: `아래 텍스트에서 정보를 추출해주세요.\n\n${prompt}\n\n[텍스트 내용]\n${textData.text.substring(0, 800000)}` }] }],
                  config: {
                    systemInstruction: "You are a data extraction specialist. Extract only the requested table data in markdown format.",
                    thinkingConfig: { thinkingLevel: model.includes("lite") ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW },
                    maxOutputTokens: 16384,
                  },
                });
                updateUsage(response);
              } else throw apiErr;
            } else throw apiErr;
          }

          const result = response.text;
          if (result) {
            setExtractedTable((prev) => {
              const cleanTableLine = (line: string) => {
                if (!line.includes('|')) return line;
                const cells = line.split('|');
                const cleanedCells = cells.map((cell, index) => {
                  const trimmed = cell.trim();
                  if (trimmed === "" || trimmed.includes('---')) return cell;
                  if (index === 1) return ` ${trimmed.replace(/년/g, '').trim()} `;
                  if (index >= 3) return ` ${trimmed.replace(/%/g, '').replace(/\+/g, '').replace(/\(([\d.]+)\)/g, '-$1').replace(/△/g, '-').trim()} `;
                  return cell;
                });
                return cleanedCells.join('|');
              };
              const newLines = result.trim().split('\n');
              let dataStartIndex = 0;
              let foundHeader = false;
              let foundSeparator = false;
              for (let j = 0; j < newLines.length; j++) {
                const line = newLines[j].trim();
                if (!line) continue;
                if (!foundHeader && (line.includes('구분(연도)') || line.includes('회사명'))) { foundHeader = true; continue; }
                if (foundHeader && !foundSeparator && (line.includes('|---|') || line.includes('|:---:|'))) { foundSeparator = true; dataStartIndex = j + 1; break; }
                if (line.startsWith('|') && line.split('|').length > 3 && !line.includes('---')) { dataStartIndex = j; break; }
              }
              const dataLines = newLines.slice(dataStartIndex).filter(l => {
                const trimmed = l.trim();
                return trimmed !== "" && !trimmed.includes('|---|') && !trimmed.includes('|:---:|') && !trimmed.includes('구분(연도)') && !trimmed.includes('회사명');
              }).map(l => cleanTableLine(l));
              if (dataLines.length === 0) return prev;
              return prev ? prev + "\n" + dataLines.join('\n') : result.trim().split('\n').slice(0, dataStartIndex).join('\n') + "\n" + dataLines.join('\n');
            });
          }
        } catch (err: any) {
          console.error(`Loss Ratio extraction error for ${file.name}:`, err);
          setErrorLog(prev => [...prev, `[손해율 추출 실패] ${file.name}: ${err.message}`]);
        }

        // --- 2. Extract Solvency Ratio (K-ICS) Data ---
        try {
          setProcessingStatus(`지급여력비율 데이터 추출 중 (${i + 1}/${targetFiles.length}): ${file.name}`);
          
          const solvencyPrompt = `업로드된 PDF 파일 내용 중 '5. 경영지표 > 5-2. 지급여력비율 > 지급여력비율의 경과조치 적용에 관한 세부 사항 > 지급여력비율의 경과조치 적용에 관한 사항 > 공통적용 경과조치 관련' 에 있는 테이블을 아래의 layout 으로 추출해서 출력해주세요.
[주의사항]
1. 반드시 마크다운 테이블 형식으로만 출력하세요.
2. 테이블 외의 어떠한 설명, 인사말, 주석, 분석 메시지도 포함하지 마세요. 오직 테이블 데이터만 출력하세요.
3. "경과조치 전"과 "경과조치 후" 데이터를 각각 행으로 구분하여 추출하세요.
4. 숫자 뒤의 '%' 기호는 모두 제거하고 숫자만 출력하세요.
5. 수치 데이터에서 "+" 기호는 제거하고, 괄호 음수(예: (1.2))나 '△'는 마이너스 기호(-)로 변환하세요.
6. 금액 단위가 있는 경우 숫자만 추출하세요.

[table layout]
|회사명|구분(경과조치)|지급여력비율|지급여력금액|기본자본|보완자본|지급여력기준금액|`;

          const contents = [
            {
              parts: [
                { text: solvencyPrompt },
                { inlineData: { data: file.base64, mimeType: file.mimeType } },
              ],
            },
          ];

          let response;
          try {
            response = await genAI.models.generateContent({
              model: selectedModel,
              contents,
              config: {
                systemInstruction: "You are a data extraction specialist. Extract only the requested table data in markdown format.",
                thinkingConfig: { thinkingLevel: selectedModel.includes("lite") ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW },
                maxOutputTokens: 16384,
              },
            });
            updateUsage(response);
          } catch (apiErr: any) {
            const errMessage = apiErr.message || (apiErr.error?.message) || String(apiErr);
            const errStr = JSON.stringify(apiErr);
            if (errMessage.includes("token") || errMessage.includes("limit") || errMessage.includes("1048576") || errMessage.includes("INVALID_ARGUMENT") || errStr.includes("token") || errStr.includes("limit") || errStr.includes("1048576") || errStr.includes("INVALID_ARGUMENT")) {
              setProcessingStatus(`토큰 초과 (지급여력): ${file.name} (텍스트 추출 모드)`);
              const textRes = await fetch("/api/extract-text", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ base64: file.base64 })
              });
              if (!textRes.ok) throw apiErr;
              const textData = await textRes.json();
              if (textData.text) {
                response = await genAI.models.generateContent({
                  model: selectedModel,
                  contents: [{ parts: [{ text: `아래 텍스트에서 정보를 추출해주세요.\n\n${solvencyPrompt}\n\n[텍스트 내용]\n${textData.text.substring(0, 800000)}` }] }],
                  config: {
                    systemInstruction: "You are a data extraction specialist. Extract only the requested table data in markdown format.",
                    thinkingConfig: { thinkingLevel: selectedModel.includes("lite") ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW },
                    maxOutputTokens: 16384,
                  },
                });
                updateUsage(response);
              } else throw apiErr;
            } else throw apiErr;
          }

          const result = response.text;
          if (result) {
            setExtractedSolvencyTable((prev) => {
              const cleanTableLine = (line: string) => {
                if (!line.includes('|')) return line;
                const cells = line.split('|');
                const cleanedCells = cells.map((cell, index) => {
                  const trimmed = cell.trim();
                  if (trimmed === "" || trimmed.includes('---')) return cell;
                  // Clean numeric data columns (Index 2 onwards)
                  if (index >= 2) {
                    let cleaned = trimmed
                      .replace(/%/g, '')
                      .replace(/\+/g, '')
                      .replace(/\(([\d,.]+)\)/g, '-$1')
                      .replace(/△/g, '-')
                      .replace(/,/g, '')
                      .trim();
                    return ` ${cleaned} `;
                  }
                  return cell;
                });
                return cleanedCells.join('|');
              };
              const newLines = result.trim().split('\n');
              let dataStartIndex = 0;
              let foundHeader = false;
              let foundSeparator = false;
              for (let j = 0; j < newLines.length; j++) {
                const line = newLines[j].trim();
                if (!line) continue;
                if (!foundHeader && (line.includes('회사명') || line.includes('지급여력비율'))) { foundHeader = true; continue; }
                if (foundHeader && !foundSeparator && (line.includes('|---|') || line.includes('|:---:|'))) { foundSeparator = true; dataStartIndex = j + 1; break; }
                if (line.startsWith('|') && line.split('|').length > 3 && !line.includes('---')) { dataStartIndex = j; break; }
              }
              const dataLines = newLines.slice(dataStartIndex).filter(l => {
                const trimmed = l.trim();
                return trimmed !== "" && !trimmed.includes('|---|') && !trimmed.includes('|:---:|') && !trimmed.includes('회사명') && !trimmed.includes('지급여력비율');
              }).map(l => cleanTableLine(l));
              if (dataLines.length === 0) return prev;
              return prev ? prev + "\n" + dataLines.join('\n') : result.trim().split('\n').slice(0, dataStartIndex).join('\n') + "\n" + dataLines.join('\n');
            });
          }
        } catch (err: any) {
          console.error(`Solvency Ratio extraction error for ${file.name}:`, err);
          setErrorLog(prev => [...prev, `[지급여력 추출 실패] ${file.name}: ${err.message}`]);
        }
      }
    } catch (err: any) {
      console.error("Extraction error:", err);
      setError("추출 중 오류가 발생했습니다.");
    } finally {
      setIsExtracting(false);
      setProcessingStatus(null);
      setUsageStats(prev => ({ ...prev, endTime: Date.now() }));
    }
  };

  const extractTable = async () => {
    if (files.length === 0) {
      setError("먼저 PDF 파일을 업로드해주세요.");
      return;
    }
    setExtractedTable(null);
    setExtractedSolvencyTable(null);
    await extractSequentially(files);
  };

  return (
    <div className="min-h-screen bg-white text-black font-sans p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <header className="mb-12 text-center">
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h1 className="text-4xl font-bold tracking-tight mb-2 text-rga-red">
              보험사 손해율/지급여력비율 추출기
            </h1>
            <p className="text-rga-warm-gray-shade text-lg">
              PDF 파일에서 특정 테이블 데이터를 자동으로 추출하고 통합합니다.
            </p>
          </motion.div>
        </header>

        <div className="flex flex-col gap-6">
          {/* Top Section: Compact Upload & Controls */}
          <div className="w-full">
            <section className="bg-white rounded-2xl shadow-md border-2 border-rga-warm-gray p-4">
              <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
                {/* URL Input Group */}
                <div className="flex-1 flex flex-col gap-3">
                  <div className="flex items-center gap-4 px-1">
                    <span className="text-xs font-bold text-rga-dark-blue uppercase tracking-wider">AI 모델 선택:</span>
                    <div className="flex bg-rga-warm-gray p-1 rounded-lg gap-1">
                      <button
                        onClick={() => setSelectedModel("gemini-3-flash-preview")}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all ${
                          selectedModel === "gemini-3-flash-preview"
                            ? "bg-white text-rga-red shadow-sm"
                            : "text-rga-warm-gray-shade hover:text-rga-dark-blue"
                        }`}
                      >
                        <Zap size={14} /> Flash (기본)
                      </button>
                      <button
                        onClick={() => setSelectedModel("gemini-3.1-flash-lite-preview")}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all ${
                          selectedModel === "gemini-3.1-flash-lite-preview"
                            ? "bg-white text-rga-blue shadow-sm"
                            : "text-rga-warm-gray-shade hover:text-rga-dark-blue"
                        }`}
                      >
                        <Cpu size={14} /> Flash Lite (속도/제한 우회)
                      </button>
                    </div>
                  </div>
                  <div className="relative flex-1">
                    <textarea
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      placeholder="PDF 다운로드 URL 입력 (여러 개일 경우 줄바꿈으로 구분)..."
                      rows={3}
                      className="w-full pl-3 pr-10 py-2 text-sm border-2 border-rga-blue-shade rounded-lg focus:outline-none focus:ring-2 focus:ring-rga-dark-blue focus:border-transparent resize-none"
                    />
                    <div className="absolute right-3 bottom-3 text-[10px] text-rga-warm-gray-shade pointer-events-none hidden sm:block">
                      .pdf, .zip
                    </div>
                  </div>
                  <button
                    onClick={fetchPdfFromUrl}
                    disabled={isFetching || !urlInput}
                    className={`w-full py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                      isFetching || !urlInput
                        ? "bg-rga-warm-gray text-rga-warm-gray-shade cursor-not-allowed"
                        : "bg-rga-dark-blue text-white hover:bg-rga-purple"
                    }`}
                  >
                    {isFetching ? <Loader2 className="animate-spin" size={16} /> : <><Download size={16} /> 가져오기 및 추출</>}
                  </button>
                </div>

                <div className="hidden md:block w-px h-6 bg-rga-warm-gray-shade" />

                {/* File Upload Button */}
                <div className="flex gap-2">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-1 md:flex-none px-4 py-2 border-2 border-rga-dark-blue rounded-lg text-sm font-medium text-rga-dark-blue hover:bg-rga-blue transition-all flex items-center justify-center gap-2 whitespace-nowrap"
                  >
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileUpload}
                      accept=".pdf"
                      multiple
                      className="hidden"
                    />
                    <FileUp size={16} />
                    파일 선택
                  </button>

                  {/* Extract Button */}
                  <button
                    onClick={extractTable}
                    disabled={isExtracting || files.length === 0}
                    className={`flex-1 md:flex-none px-6 py-2 rounded-lg font-semibold flex items-center justify-center gap-2 transition-all whitespace-nowrap ${
                      isExtracting || files.length === 0
                        ? "bg-rga-warm-gray text-rga-warm-gray-shade cursor-not-allowed"
                        : "bg-rga-red text-white hover:bg-rga-purple shadow-sm hover:shadow-md active:scale-[0.98]"
                    }`}
                  >
                    {isExtracting ? (
                      <Loader2 className="animate-spin" size={18} />
                    ) : (
                      <>
                        <TableIcon size={18} />
                        추출하기
                      </>
                    )}
                  </button>

                  {/* Clear Button */}
                  <button
                    onClick={handleClear}
                    disabled={isExtracting || isFetching || (files.length === 0 && !urlInput && !extractedTable)}
                    className={`flex-1 md:flex-none px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 border-2 ${
                      isExtracting || isFetching || (files.length === 0 && !urlInput && !extractedTable)
                        ? "border-rga-warm-gray text-rga-warm-gray-shade cursor-not-allowed"
                        : "border-rga-red text-rga-red hover:bg-red-50"
                    }`}
                    title="모두 지우기"
                  >
                    <Trash2 size={16} />
                    초기화
                  </button>
                </div>
              </div>

              {/* File List (Compact) */}
              <AnimatePresence>
                {files.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mt-3 pt-3 border-t border-[#F1F3F4] flex flex-wrap gap-2"
                  >
                    {files.map((file, idx) => (
                      <motion.div
                        key={idx}
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="flex items-center gap-2 px-2 py-1 bg-white rounded border-2 border-rga-blue-shade max-w-[200px]"
                      >
                        <FileText size={14} className="text-rga-red shrink-0" />
                        <span className="text-xs truncate font-medium text-rga-dark-blue">{file.name}</span>
                        <button
                          onClick={() => removeFile(idx)}
                          className="text-rga-warm-gray-shade hover:text-rga-red ml-1"
                        >
                          &times;
                        </button>
                      </motion.div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </section>

            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-3 bg-rga-yellow/20 border border-rga-yellow p-3 rounded-xl flex items-start gap-3 text-rga-purple"
              >
                <AlertCircle size={18} className="shrink-0 mt-0.5 text-rga-orange" />
                <p className="text-xs font-medium">{error}</p>
              </motion.div>
            )}
          </div>

          {/* Bottom Section: Result */}
          <div className="w-full space-y-6">
            {/* Loss Ratio Table */}
            <AnimatePresence>
              {usageStats.endTime && (
                <motion.section
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="bg-rga-warm-gray/20 rounded-2xl border-2 border-rga-blue-shade p-4 flex flex-wrap items-center justify-center gap-x-8 gap-y-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-rga-warm-gray-shade uppercase tracking-widest">총 소요 시간</span>
                    <span className="text-sm font-bold text-rga-dark-blue">
                      {((usageStats.endTime - (usageStats.startTime || 0)) / 1000).toFixed(1)}s
                    </span>
                  </div>
                  <div className="w-px h-4 bg-rga-blue-shade/30 hidden sm:block" />
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-rga-warm-gray-shade uppercase tracking-widest">총 사용 토큰</span>
                    <span className="text-sm font-bold text-rga-dark-blue">
                      {usageStats.totalTokens.toLocaleString()} <span className="text-[10px] font-normal opacity-60">(In: {usageStats.promptTokens.toLocaleString()} / Out: {usageStats.candidatesTokens.toLocaleString()})</span>
                    </span>
                  </div>
                  <div className="w-px h-4 bg-rga-blue-shade/30 hidden sm:block" />
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-rga-warm-gray-shade uppercase tracking-widest">예상 비용 ({selectedModel.includes("lite") ? "Flash Lite" : "Flash"})</span>
                    <span className="text-sm font-bold text-rga-red">
                      ${usageStats.cost.toFixed(4)}
                    </span>
                  </div>
                </motion.section>
              )}
            </AnimatePresence>

            <section className="bg-white rounded-2xl shadow-md border-2 border-rga-warm-gray min-h-[150px] flex flex-col overflow-hidden">
              <div className="p-4 bg-rga-dark-blue flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-white flex items-center gap-2">
                  <TableIcon size={16} /> 보험금 예실차비율 (손해율)
                </h2>
                {extractedTable && (
                  <button
                    onClick={() => copyToClipboardAsTsv(extractedTable)}
                    className="text-xs font-medium text-rga-blue hover:text-white transition-colors"
                  >
                    복사하기
                  </button>
                )}
              </div>

              <div className="flex-1 p-6 overflow-auto">
                {isFetching || isExtracting ? (
                  <div className="h-full min-h-[150px] flex flex-col items-center justify-center text-rga-warm-gray-shade space-y-4">
                    <Loader2 className="animate-spin text-rga-red" size={48} />
                    <div className="text-center">
                      <p className="animate-pulse font-medium text-rga-dark-blue">
                        {processingStatus || "처리 중..."}
                      </p>
                      <p className="text-[10px] mt-1 text-rga-green font-medium">
                        {processingStatus?.includes("최적화") ? "토큰 절약을 위해 관련 페이지만 추출 중입니다." : "대용량 PDF는 자동으로 최적화되어 처리됩니다."}
                      </p>
                      <p className="text-xs mt-1">잠시만 기다려주세요.</p>
                    </div>
                  </div>
                ) : extractedTable ? (
                  <div className="prose prose-sm max-w-none prose-table:border prose-table:border-rga-blue-shade prose-th:bg-rga-warm-gray prose-th:p-3 prose-td:p-3 prose-th:border prose-td:border-rga-blue-shade prose-table:w-full">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{extractedTable}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="h-full min-h-[100px] flex flex-col items-center justify-center text-rga-warm-gray-shade text-center">
                    <TableIcon size={48} strokeWidth={1} className="mb-3 opacity-20 text-rga-dark-blue" />
                    <p className="text-base font-medium text-rga-dark-blue">추출된 데이터가 여기에 표시됩니다</p>
                  </div>
                )}
              </div>
            </section>

            {/* Solvency Ratio Table */}
            <section className="bg-white rounded-2xl shadow-md border-2 border-rga-warm-gray min-h-[150px] flex flex-col overflow-hidden">
              <div className="p-4 bg-rga-purple flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-white flex items-center gap-2">
                  <TableIcon size={16} /> 지급여력비율 (K-ICS)
                </h2>
                {extractedSolvencyTable && (
                  <button
                    onClick={() => copyToClipboardAsTsv(extractedSolvencyTable)}
                    className="text-xs font-medium text-rga-blue hover:text-white transition-colors"
                  >
                    복사하기
                  </button>
                )}
              </div>

              <div className="flex-1 p-6 overflow-auto">
                {isFetching || isExtracting ? (
                  <div className="h-full min-h-[150px] flex flex-col items-center justify-center text-rga-warm-gray-shade space-y-4">
                    <Loader2 className="animate-spin text-rga-red" size={48} />
                    <div className="text-center">
                      <p className="animate-pulse font-medium text-rga-dark-blue">
                        {processingStatus || "처리 중..."}
                      </p>
                      <p className="text-[10px] mt-1 text-rga-green font-medium">
                        {processingStatus?.includes("최적화") ? "토큰 절약을 위해 관련 페이지만 추출 중입니다." : "대용량 PDF는 자동으로 최적화되어 처리됩니다."}
                      </p>
                      <p className="text-xs mt-1">잠시만 기다려주세요.</p>
                    </div>
                  </div>
                ) : extractedSolvencyTable ? (
                  <div className="prose prose-sm max-w-none prose-table:border prose-table:border-rga-blue-shade prose-th:bg-rga-warm-gray prose-th:p-3 prose-td:p-3 prose-th:border prose-td:border-rga-blue-shade prose-table:w-full">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{extractedSolvencyTable}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="h-full min-h-[100px] flex flex-col items-center justify-center text-rga-warm-gray-shade text-center">
                    <TableIcon size={48} strokeWidth={1} className="mb-3 opacity-20 text-rga-purple" />
                    <p className="text-base font-medium text-rga-dark-blue">지급여력비율 데이터가 여기에 표시됩니다</p>
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* URL Extraction Guide */}
          <div className="w-full">
            <section className="bg-rga-warm-gray/30 rounded-2xl border-2 border-rga-warm-gray p-5">
              <h2 className="text-base font-bold text-rga-dark-blue mb-4 flex items-center gap-2">
                <HelpCircle size={18} /> PDF URL 추출 방법 안내
              </h2>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Life Insurance */}
                <div className="space-y-2">
                  <h3 className="text-sm font-bold text-rga-red border-l-4 border-rga-red pl-2">생명보험</h3>
                  <ol className="text-xs text-black space-y-1.5 list-decimal list-inside">
                    <li>
                      <a 
                        href="https://pub.insure.or.kr/mngtDis/mngtDis/list.do" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-rga-dark-blue hover:underline font-medium"
                      >
                        생명보험협회 정기경영공시
                      </a> 접속
                    </li>
                    <li>개발자모드(F12 버튼) 클릭 - 네트워크 항목</li>
                    <li>원하는 보고서 다운로드 버튼 클릭</li>
                    <li>클릭 후 개발자 모드의 헤더 - 요청 URL 에 있는 <br/>
                      <code className="bg-white px-1 rounded border border-rga-blue-shade text-[10px] break-all">
                        https://pub.insure.or.kr/FileDown.do?fileNo=&#123;fileNo&#125;&seq=1
                      </code> <br/>
                      과 같은 주소 복사 후 입력
                    </li>
                  </ol>
                </div>

                {/* Non-Life Insurance */}
                <div className="space-y-2">
                  <h3 className="text-sm font-bold text-rga-dark-blue border-l-4 border-rga-dark-blue pl-2">손해보험</h3>
                  <ol className="text-xs text-black space-y-1.5 list-decimal list-inside">
                    <li>
                      <a 
                        href="https://kpub.knia.or.kr/managementDisc/regularly/regularlyDisclosure.do" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-rga-dark-blue hover:underline font-medium"
                      >
                        손해보험협회 정기경영공시
                      </a> 접속
                    </li>
                    <li>PDF 링크 우클릭 후 링크 주소 복사 후 입력</li>
                  </ol>
                </div>
              </div>
            </section>
          </div>

          {/* Error Log Section */}
          {errorLog.length > 0 && (
            <div className="w-full">
              <section className="bg-red-50 rounded-2xl border-2 border-red-200 p-5">
                <h2 className="text-base font-bold text-red-700 mb-3 flex items-center gap-2">
                  <AlertCircle size={18} /> Error Log
                </h2>
                <div className="bg-white/50 rounded-xl p-4 font-mono text-[10px] text-red-600 max-h-[200px] overflow-auto border border-red-100">
                  {errorLog.map((log, idx) => (
                    <div key={idx} className="py-1 border-b border-red-50 last:border-0">
                      <span className="opacity-50 mr-2">[{new Date().toLocaleTimeString()}]</span>
                      {log}
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}
        </div>

        {/* Footer Info */}
        <footer className="mt-12 pt-8 border-t border-rga-blue-shade text-center text-rga-warm-gray-shade text-xs">
          <p>© 2026 보험사 손해율 정보 추출기 | Powered by Google Gemini AI</p>
        </footer>
      </div>
    </div>
  );
}
