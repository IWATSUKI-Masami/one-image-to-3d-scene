import React, { useRef } from 'react';
import { Upload } from 'lucide-react';

interface ImageUploaderProps {
  onImageSelected: (files: File[]) => void;
  isLoading: boolean;
  multiple?: boolean;
  title?: string;
  description?: string;
  icon?: React.ReactNode;
}

export const ImageUploader: React.FC<ImageUploaderProps> = ({ 
  onImageSelected, 
  isLoading, 
  multiple = false,
  title = "Click to upload or drag & drop",
  description = "Supports JPG, PNG, WEBP (Max 10MB)",
  icon
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onImageSelected(Array.from(e.target.files));
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const droppedFiles = Array.from(e.dataTransfer.files).filter((file: File) => file.type.startsWith('image/'));
    if (droppedFiles.length > 0) {
      onImageSelected(droppedFiles);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  return (
    <div
      className={`border-2 border-dashed rounded-xl p-8 text-center transition-all duration-200 cursor-pointer h-full flex flex-col items-center justify-center
        ${isLoading ? 'opacity-50 pointer-events-none border-gray-300' : 'border-slate-300 hover:border-blue-500 hover:bg-slate-50'}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onClick={() => fileInputRef.current?.click()}
    >
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="image/*"
        multiple={multiple}
        onChange={handleFileChange}
      />
      <div className="flex flex-col items-center gap-4 text-slate-600">
        <div className="bg-blue-100 p-4 rounded-full text-blue-600">
          {icon || <Upload size={32} />}
        </div>
        <div>
          <h3 className="text-lg font-semibold text-slate-800">{title}</h3>
          <p className="text-sm text-slate-500 mt-1">{description}</p>
        </div>
      </div>
    </div>
  );
};
