import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// Promo-only output. Does not alter the app or the supplied originals.
const dir = 'promo/polished';
const filter = String.raw`
color=c=0x0e0d0b:s=1080x1350:r=30:d=5[bg];
[1:v]scale=350:350:flags=lanczos,format=rgba,trim=duration=5,setpts=PTS-STARTPTS,fade=t=in:st=0.1:d=0.75:alpha=1[logo];
[bg][logo]overlay=x=(W-w)/2:y='340-8*min(t/2,1)':shortest=1,
drawtext=fontfile='promo/polished/InstrumentSerif-Regular.ttf':text='Atelier':fontsize=156:fontcolor=0xece6d9:x=(w-text_w)/2:y=715:alpha='clip((t-0.5)/0.65,0,1)',
drawtext=fontfile='C\:/Windows/Fonts/segoeui.ttf':text='A personal AI studio. Shaped around you.':fontsize=32:fontcolor=0xbdb7aa:x=(w-text_w)/2:y=905:alpha='clip((t-1.0)/0.65,0,1)',
fade=t=out:st=4.45:d=0.55:color=0x0e0d0b,setsar=1,format=yuv420p[intro];
[0:v]trim=start=5:end=40,setpts=PTS-STARTPTS,setsar=1,format=yuv420p[middle];
[2:v]scale=2160:2700:flags=lanczos,zoompan=z='1+0.012*on/239':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1080x1350:fps=30,trim=duration=8,setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.4:color=0x0e0d0b,setsar=1,format=yuv420p[outro];
[intro][middle][outro]concat=n=3:v=1:a=0,format=yuv420p[v]
`.trim();
writeFileSync(`${dir}/video-filter.txt`, filter);
const result = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'warning', '-y',
  '-i', 'C:/Users/cole/Downloads/Atelier-promo-4x5.mp4',
  '-loop', '1', '-framerate', '30', '-i', `${dir}/Atelier-A-transparent.png`,
  '-loop', '1', '-framerate', '30', '-i', `${dir}/Atelier-promo-thumbnail-polished.png`,
  '-filter_complex_threads', '2', '-/filter_complex', `${dir}/video-filter.txt`,
  '-map', '[v]', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'medium',
  '-crf', '18', '-threads', '4', '-c:a', 'copy', '-t', '48', '-r', '30',
  '-movflags', '+faststart', '-map_metadata', '-1',
  `${dir}/Atelier-promo-4x5-polished.mp4`,
], { stdio: 'inherit' });
process.exit(result.status ?? 1);
