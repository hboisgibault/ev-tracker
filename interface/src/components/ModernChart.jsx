import React, { useMemo, useState, useRef } from 'react';
import { 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  ResponsiveContainer 
} from 'recharts';

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white/95 backdrop-blur-sm border border-gray-200 rounded-lg shadow-xl p-4">
        <p className="font-semibold text-gray-900 mb-2">{label}</p>
        <div className="space-y-1">
          {payload.reverse().map((entry, index) => (
            <div key={index} className="flex items-center justify-between gap-4 text-sm">
              <div className="flex items-center gap-2">
                <div 
                  className="w-3 h-3 rounded-full" 
                  style={{ backgroundColor: entry.color }}
                />
                <span className="text-gray-700">{entry.name}</span>
              </div>
              <span className="font-semibold text-gray-900">
                {entry.value.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return null;
};

const CustomLegend = ({ payload, toggleSeries, hiddenSeries }) => {
  return (
    <div className="flex flex-wrap gap-4 justify-center mb-2">
      {payload.map((entry, index) => (
        <button
          key={`legend-${index}`}
          onClick={() => toggleSeries(entry.dataKey)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-full transition-all ${
            hiddenSeries.has(entry.dataKey)
              ? 'opacity-40 hover:opacity-60'
              : 'hover:bg-gray-100'
          }`}
        >
          <div 
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-sm font-medium text-gray-700">
            {entry.value}
          </span>
        </button>
      ))}
    </div>
  );
};

export default function ModernChart({ labels, datasets, title }) {
  const [hiddenSeries, setHiddenSeries] = useState(new Set());
  const [range, setRange] = useState('all'); // all | 24 | 12
  const chartContainerRef = useRef(null);

  const sliceCount = range === 'all' ? labels.length : parseInt(range, 10);
  const slicedLabels = labels.slice(-sliceCount);
  const slicedDatasets = datasets.map((ds) => ({
    ...ds,
    data: ds.data.slice(-sliceCount),
  }));

  // Transform data for Recharts format
  const chartData = useMemo(() => {
    return slicedLabels.map((label, index) => {
      const dataPoint = { date: label };
      slicedDatasets.forEach((dataset) => {
        dataPoint[dataset.label] = dataset.data[index];
      });
      return dataPoint;
    });
  }, [slicedLabels, slicedDatasets]);

  const toggleSeries = (dataKey) => {
    setHiddenSeries(prev => {
      const newSet = new Set(prev);
      if (newSet.has(dataKey)) {
        newSet.delete(dataKey);
      } else {
        newSet.add(dataKey);
      }
      return newSet;
    });
  };

  const handleDownload = () => {
    if (!chartContainerRef.current) return;
    
    // Find the chart SVG element (Recharts uses 'recharts-surface' class)
    // We explicitly avoid selecting the icon SVG in the button causing the "down arrow" issue
    const svg = chartContainerRef.current.querySelector('.recharts-surface');
    if (!svg) return;

    // Get the real size
    const rect = svg.getBoundingClientRect();

    // Clone the SVG to modify it safely
    const clonedSvg = svg.cloneNode(true);
    
    // Explicitly set width/height in pixels (required for some browsers/contexts)
    clonedSvg.setAttribute("width", rect.width);
    clonedSvg.setAttribute("height", rect.height);
    
        <div className="mt-2 py-2">
          <CustomLegend 
            payload={datasets.map((ds, i) => ({
              dataKey: ds.label,
              color: ds.borderColor,
              value: ds.label,
            }))}
            toggleSeries={toggleSeries}
            hiddenSeries={hiddenSeries}
          />
        </div>
    // Serialize SVG to XML string
    const serializer = new XMLSerializer();
    let svgStr = serializer.serializeToString(clonedSvg);
    
    // Ensure proper namespace
    if (!svgStr.includes('xmlns="http://www.w3.org/2000/svg"')) {
      svgStr = svgStr.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    
    // Convert to Base64
    const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      
      // Increase resolution for better quality
      const scale = 2;
      // Add extra space at the top for the title if it exists
      const titleHeight = title ? 40 : 0;
      
      canvas.width = rect.width * scale;
      canvas.height = (rect.height + titleHeight) * scale;
      
      const ctx = canvas.getContext('2d');
      // Fill white background (transparent by default)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      if (title) {
        // Use a standard font that is likely to be available
        ctx.font = `bold ${16 * scale}px Arial, sans-serif`;
        ctx.fillStyle = '#111827';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(title, canvas.width / 2, (titleHeight / 2) * scale);
      }

      ctx.save(); // Save state before scaling
      ctx.scale(scale, scale);
      // Draw image with offset for title
      ctx.drawImage(img, 0, titleHeight);
      ctx.restore(); // Restore state
      
      const link = document.createElement('a');
      link.download = `ev-market-share-${title ? title.replace(/[^a-z0-9]/gi, '-').toLowerCase() : 'chart'}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  return (
    <div className="w-full space-y-3">
      {/* Controls */}
      <div className="flex justify-start sm:justify-end items-center gap-3 text-sm text-gray-600 flex-wrap">
        <button
          onClick={handleDownload}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors border border-blue-200"
          title="Download chart as PNG"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Share Chart
        </button>
        <span className="w-px h-4 bg-gray-300"></span>
        <label className="flex items-center gap-2">
          <span>Range:</span>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="border border-gray-200 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
          >
            <option value="all">All</option>
            <option value="24">Last 24 months</option>
            <option value="12">Last 12 months</option>
          </select>
        </label>
      </div>

      {/* Chart container with fixed height */}
      <div className="w-full h-[300px] sm:h-[400px] lg:h-[500px]" ref={chartContainerRef}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart 
            data={chartData}
            margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
          >
            <CartesianGrid 
              strokeDasharray="3 3" 
              stroke="#e5e7eb" 
              vertical={false}
            />
            <XAxis 
              dataKey="date" 
              stroke="#9ca3af"
              tick={{ fontSize: 12 }}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={50}
            />
            <YAxis 
              stroke="#9ca3af"
              tick={{ fontSize: 12 }}
              tickLine={false}
              domain={[0, 100]}
              label={{ 
                value: 'Market Share (%)', 
                angle: -90, 
                position: 'insideLeft',
                style: { fontSize: 12, fill: '#6b7280' }
              }}
            />
            <Tooltip content={<CustomTooltip />} />
            {datasets.map((dataset, index) => (
              <Area
                key={index}
                type="monotone"
                dataKey={dataset.label}
                stackId="1"
                stroke={dataset.borderColor}
                fill={dataset.backgroundColor}
                strokeWidth={2}
                hide={hiddenSeries.has(dataset.label)}
                animationDuration={800}
                animationEasing="ease-in-out"
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div>
        <CustomLegend 
          payload={datasets.map((ds, i) => ({
            dataKey: ds.label,
            color: ds.borderColor,
            value: ds.label,
          }))}
          toggleSeries={toggleSeries}
          hiddenSeries={hiddenSeries}
        />
      </div>
    </div>
  );
}
