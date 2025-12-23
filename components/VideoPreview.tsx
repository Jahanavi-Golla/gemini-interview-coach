
import React, { useEffect, useRef } from 'react';

interface VideoPreviewProps {
  onFrame?: (base64Frame: string) => void;
  isActive: boolean;
}

const VideoPreview: React.FC<VideoPreviewProps> = ({ onFrame, isActive }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let interval: number | null = null;

    const startStream = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: 640, height: 480 }, 
          audio: false 
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }

        if (onFrame) {
          interval = window.setInterval(() => {
            if (videoRef.current && canvasRef.current) {
              const ctx = canvasRef.current.getContext('2d');
              if (ctx) {
                canvasRef.current.width = videoRef.current.videoWidth;
                canvasRef.current.height = videoRef.current.videoHeight;
                ctx.drawImage(videoRef.current, 0, 0);
                const base64Frame = canvasRef.current.toDataURL('image/jpeg', 0.6).split(',')[1];
                onFrame(base64Frame);
              }
            }
          }, 2000); // 2 seconds between frames for analysis
        }
      } catch (err) {
        console.error('Error accessing webcam:', err);
      }
    };

    if (isActive) {
      startStream();
    }

    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [isActive, onFrame]);

  return (
    <div className="relative w-full aspect-video rounded-2xl overflow-hidden border-2 border-slate-700 glass shadow-2xl">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-cover scale-x-[-1]"
      />
      <canvas ref={canvasRef} className="hidden" />
      <div className="absolute bottom-4 left-4 px-3 py-1 bg-black/50 backdrop-blur text-xs font-medium rounded-full text-slate-300">
        Live Feed
      </div>
    </div>
  );
};

export default VideoPreview;
