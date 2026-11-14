import { useEffect, useRef, useState } from 'react';

interface SpeechResult {isFinal:boolean;0:{transcript:string}}
interface Recognition {
  continuous:boolean;interimResults:boolean;lang:string;
  onresult:((event:{resultIndex:number;results:ArrayLike<SpeechResult>})=>void)|null;
  onerror:((event:{error:string})=>void)|null;onend:(()=>void)|null;
  start():void;stop():void;abort():void;
}

/** Browser dictation never submits a prompt or creates an ECR by itself. */
export function useDictation(onText:(text:string)=>void){
  const [listening,setListening]=useState(false),[interim,setInterim]=useState(''),[error,setError]=useState('');
  const recognition=useRef<Recognition|null>(null),callback=useRef(onText);callback.current=onText;
  const constructor=(globalThis as unknown as {SpeechRecognition?:new()=>Recognition;webkitSpeechRecognition?:new()=>Recognition}).SpeechRecognition??(globalThis as unknown as {webkitSpeechRecognition?:new()=>Recognition}).webkitSpeechRecognition;
  useEffect(()=>()=>{const active=recognition.current;if(active){active.onend=null;active.onerror=null;active.onresult=null;active.abort();}},[]);
  function toggle(){
    if(listening){recognition.current?.stop();return;}
    if(!constructor){setError('Dictation is unavailable in this browser. Type your instructions below.');return;}
    setError('');setInterim('');
    const active=new constructor();recognition.current=active;active.continuous=false;active.interimResults=true;active.lang=navigator.language||'en-US';
    active.onresult=event=>{let pending='';for(let index=event.resultIndex;index<event.results.length;index++){const result=event.results[index];if(result.isFinal)callback.current(result[0].transcript.trim());else pending+=result[0].transcript;}setInterim(pending);};
    active.onerror=event=>{setListening(false);setInterim('');setError(event.error==='not-allowed'?'Microphone permission was not granted. You can continue by typing.':event.error==='no-speech'?'No speech was detected. Try again or type your instructions.':'Dictation could not finish. Your typed instructions are still available.');};
    active.onend=()=>{setListening(false);setInterim('');};
    try{active.start();setListening(true);}catch{setListening(false);setError('Dictation could not start. Type your instructions below.');}
  }
  return {available:!!constructor,listening,interim,error,toggle};
}
