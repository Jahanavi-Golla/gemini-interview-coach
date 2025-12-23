
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { Sentiment, FeedbackMessage, TranscriptionEntry } from './types';
import { decode, decodeAudioData, createPcmBlob } from './services/audio-processing';
import VideoPreview from './components/VideoPreview';
import InterviewerAvatar from './components/InterviewerAvatar';
import FeedbackList from './components/FeedbackList';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';

// Define tools for the model to use to communicate feedback to the UI
const provideFeedbackTool: FunctionDeclaration = {
  name: 'provideFeedback',
  description: 'Provide real-time feedback to the user based on their communication, posture, tone, or content.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      category: { type: Type.STRING, description: 'The area of feedback (e.g., Posture, Tone, Content, Pace)' },
      message: { type: Type.STRING, description: 'The constructive feedback message' },
      sentiment: { 
        type: Type.STRING, 
        enum: [Sentiment.POSITIVE, Sentiment.NEUTRAL, Sentiment.IMPROVEMENT],
        description: 'The tone of the feedback'
      },
    },
    required: ['category', 'message', 'sentiment']
  }
};

const App: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [feedbacks, setFeedbacks] = useState<FeedbackMessage[]>([]);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Audio refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const transcriptionBufferRef = useRef({ user: '', model: '' });

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close?.();
      sessionRef.current = null;
    }
    setIsActive(false);
    setIsSpeaking(false);
    sourcesRef.current.forEach(s => s.stop());
    sourcesRef.current.clear();
  }, []);

  const startSession = async () => {
    try {
      setError(null);
      setIsActive(true);
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // Setup Audio Contexts
      if (!audioContextRef.current) audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      if (!outputAudioContextRef.current) outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: `You are a real-time interview system.
            Language rules:
            - All interaction must be strictly in English.
            - Transcribe speech only in English.
            - If speech is unclear or in another language, ask the user to repeat in English.

            You have two roles:
            1. Interviewer
            2. Communication coach

            Interview behavior:
            - Start with a brief introduction.
            - Ask one interview question at a time.
            - Wait until the candidate finishes speaking before responding.
            - Ask follow-up questions when answers are unclear or incomplete.
            - Adapt questions based on previous responses.
            - Maintain interview context throughout the session.

            Live coaching behavior:
            - Continuously observe live audio and video input.
            - Detect clear communication signals such as:
              - Excess filler words
              - Speaking too fast or too slowly
              - Answer drifting from the question
              - Strong clarity or structure
              - Limited eye contact or excessive movement
            - Provide feedback ONLY when a clear signal is detected.
            - Feedback must be under 12 words.
            - Do not repeat the same feedback consecutively.
            - Do not interrupt the candidate while speaking.

            Feedback scope:
            - Speech pace
            - Clarity and structure
            - Relevance of answers
            - Use of filler words
            - Basic non-verbal cues (eye direction, posture)

            Restrictions:
            - Do not provide medical, psychological, or diagnostic advice.
            - Feedback must be skill-focused and observational.

            Ending the interview:
            - When the candidate says “end interview”, stop asking questions.
            - Generate a concise post-interview performance summary including:
              - Strengths
              - Areas for improvement
              - Communication observations`,
          tools: [{ functionDeclarations: [provideFeedbackTool] }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log('Gemini Live session opened');
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            // Handle Audio Output
            const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) {
              setIsSpeaking(true);
              const ctx = outputAudioContextRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const audioBuffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsSpeaking(false);
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            // Handle Interruptions
            if (msg.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }

            // Handle Transcriptions
            if (msg.serverContent?.inputTranscription) {
              transcriptionBufferRef.current.user += msg.serverContent.inputTranscription.text;
            }
            if (msg.serverContent?.outputTranscription) {
              transcriptionBufferRef.current.model += msg.serverContent.outputTranscription.text;
            }
            if (msg.serverContent?.turnComplete) {
              const uText = transcriptionBufferRef.current.user;
              const mText = transcriptionBufferRef.current.model;
              if (uText || mText) {
                setTranscriptions(prev => [
                  ...prev,
                  ...(uText ? [{ role: 'user', text: uText, timestamp: Date.now() } as TranscriptionEntry] : []),
                  ...(mText ? [{ role: 'model', text: mText, timestamp: Date.now() } as TranscriptionEntry] : []),
                ]);
              }
              transcriptionBufferRef.current = { user: '', model: '' };
            }

            // Handle Tool Calls (Feedback)
            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'provideFeedback') {
                  const args = fc.args as any;
                  setFeedbacks(prev => [{
                    id: Math.random().toString(36).substr(2, 9),
                    category: args.category,
                    message: args.message,
                    sentiment: args.sentiment as Sentiment,
                    timestamp: Date.now()
                  }, ...prev]);
                  
                  // Acknowledge tool response
                  sessionPromise.then(session => {
                    session.sendToolResponse({
                      functionResponses: { id: fc.id, name: fc.name, response: { result: "feedback_received" } }
                    });
                  });
                }
              }
            }
          },
          onerror: (e) => {
            console.error('Session error:', e);
            setError('Communication lost. Please try restarting the session.');
            stopSession();
          },
          onclose: () => {
            console.log('Session closed');
            setIsActive(false);
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error('Failed to start session:', err);
      setError('Could not access microphone or camera. Please check permissions.');
      setIsActive(false);
    }
  };

  const handleFrame = useCallback((base64: string) => {
    if (sessionRef.current && isActive) {
      sessionRef.current.sendRealtimeInput({
        media: { data: base64, mimeType: 'image/jpeg' }
      });
    }
  }, [isActive]);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-slate-950">
      {/* Header */}
      <header className="h-16 flex items-center justify-between px-6 glass border-b border-slate-800 z-10">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-900/20">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-white">
              <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM12.75 6a.75.75 0 0 0-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 0 0 0-1.5h-3.75V6Z" clipRule="evenodd" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-100 leading-tight">Gemini Interview Coach</h1>
            <p className="text-[10px] text-slate-400 uppercase tracking-widest">Real-Time Performance Analysis</p>
          </div>
        </div>
        
        <div className="flex items-center space-x-4">
          {!isActive ? (
            <button
              onClick={startSession}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-full shadow-lg transition-all active:scale-95 flex items-center space-x-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
              </svg>
              <span>Start Interview</span>
            </button>
          ) : (
            <button
              onClick={stopSession}
              className="px-6 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/50 font-semibold rounded-full transition-all active:scale-95"
            >
              End Session
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden p-6 gap-6">
        {/* Left Side: Video & Interaction */}
        <div className="flex-1 flex flex-col space-y-6">
          <div className="flex-1 flex gap-6 min-h-0">
            {/* User Feed */}
            <div className="flex-1 flex flex-col">
              <div className="flex items-center mb-3 space-x-2">
                <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                <span className="text-sm font-semibold text-slate-300">Candidate View</span>
              </div>
              <VideoPreview isActive={isActive} onFrame={handleFrame} />
            </div>

            {/* Coach Feed */}
            <div className="w-1/3 flex flex-col glass rounded-2xl overflow-hidden shadow-2xl">
               <div className="flex items-center p-4 border-b border-slate-800 space-x-2">
                <div className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-sm font-semibold text-slate-300">AI Coach (Alex)</span>
              </div>
              <div className="flex-1 flex items-center justify-center bg-slate-900/50">
                <InterviewerAvatar isSpeaking={isSpeaking} />
              </div>
            </div>
          </div>

          {/* Bottom Transcription Area */}
          <div className="h-48 glass rounded-2xl p-4 overflow-hidden flex flex-col">
            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">Live Transcript</h4>
            <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
              {transcriptions.length === 0 ? (
                <p className="text-slate-600 italic text-sm text-center py-8">Transcription will appear as you speak...</p>
              ) : (
                transcriptions.map((t, i) => (
                  <div key={i} className={`flex space-x-3 ${t.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] px-4 py-2 rounded-2xl text-sm ${
                      t.role === 'user' 
                        ? 'bg-blue-600/20 text-blue-100 rounded-tr-none' 
                        : 'bg-slate-800 text-slate-200 rounded-tl-none'
                    }`}>
                      <p>{t.text}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right Side: Real-time Feedback Panel */}
        <div className="w-80 flex flex-col space-y-4">
          <div className="glass rounded-2xl p-5 flex flex-col h-full overflow-hidden">
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-bold text-slate-100 flex items-center space-x-2">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-amber-500">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" />
                </svg>
                <span>Performance Feed</span>
              </h2>
              <span className="bg-slate-800 text-slate-400 text-[10px] px-2 py-0.5 rounded font-bold">{feedbacks.length}</span>
            </div>
            <FeedbackList feedbacks={feedbacks} />
          </div>
        </div>
      </main>

      {/* Error Overlay */}
      {error && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-6">
          <div className="bg-slate-900 border border-red-500/50 p-8 rounded-3xl max-w-md w-full shadow-2xl text-center">
            <div className="w-16 h-16 bg-red-600/20 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-8 h-8 text-red-500">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-white mb-2">Session Error</h3>
            <p className="text-slate-400 mb-8">{error}</p>
            <button 
              onClick={() => setError(null)}
              className="w-full py-3 bg-slate-800 hover:bg-slate-700 text-white font-semibold rounded-xl transition-all"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Splash Screen */}
      {!isActive && transcriptions.length === 0 && (
        <div className="fixed inset-0 flex items-center justify-center pointer-events-none z-0 opacity-20">
          <div className="text-center">
            <div className="w-64 h-64 bg-blue-600/20 rounded-full blur-[100px] absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={0.5} stroke="currentColor" className="w-48 h-48 text-slate-700 mx-auto mb-8 animate-pulse">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
            </svg>
            <h2 className="text-4xl font-bold text-slate-800">Ready to Interview?</h2>
            <p className="text-slate-700 max-w-sm mx-auto mt-4">Connect your mic and camera to start your personalized coaching session.</p>
          </div>
        </div>
      )}

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
        @keyframes slide-in {
          from { opacity: 0; transform: translateX(20px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .animate-slide-in {
          animation: slide-in 0.3s ease-out forwards;
        }
      `}</style>
    </div>
  );
};

export default App;
