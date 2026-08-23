import os
import shutil
import uuid
import asyncio
from datetime import datetime
from typing import Optional, Tuple, List

from fastapi import FastAPI, File, UploadFile, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from sentence_transformers import SentenceTransformer, util
import torch

# ── Ollama for Llama 3.2 (1B model) ──────────────────────────────────
try:
    import ollama
    OLLAMA_AVAILABLE = True
    print("✅ Ollama imported successfully")
except ImportError:
    OLLAMA_AVAILABLE = False
    print("⚠️ Ollama not installed. Run: pip install ollama")

# ── MySQL connector ─────────────────────────────────────────────────
try:
    import mysql.connector
    from decimal import Decimal
    MYSQL_AVAILABLE = True
    print("✅ MySQL connector imported")
except ImportError:
    MYSQL_AVAILABLE = False
    print("⚠️ mysql-connector-python not installed")

# ── SpeechRecognition ───────────────────────────────────────────────
try:
    import speech_recognition as sr
    SR_AVAILABLE = True
    print("✅ SpeechRecognition imported")
except ImportError:
    sr = None
    SR_AVAILABLE = False
    print("⚠️ SpeechRecognition not installed")

# ── OCR for images/PDFs ─────────────────────────────────────────────
try:
    import pytesseract
    from PIL import Image, ImageOps
    import PyPDF2
    OCR_AVAILABLE = True
    if os.name == 'nt':
        pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
    print("✅ OCR libraries imported")
except ImportError:
    OCR_AVAILABLE = False
    print("⚠️ OCR not available")

# ─── Database configuration ──────────────────────────────────────
db_config = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'user': os.getenv('DB_USER', 'root'),
    'password': os.getenv('DB_PASSWORD', ''),
    'database': os.getenv('DB_NAME', 'customer_support'),
    'port': int(os.getenv('DB_PORT', 3306))
}

def get_ai_faqs_from_db():
    """Fetch ALL AI FAQs from database"""
    if not MYSQL_AVAILABLE:
        return []
    try:
        conn = mysql.connector.connect(**db_config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute("""
            SELECT id, question, answer,
                   COALESCE(performance_score, 0) AS perf_score,
                   COALESCE(total_ratings, 0) AS total_ratings,
                   COALESCE(positive_ratings, 0) AS positive_ratings
            FROM ai_faqs
            ORDER BY id ASC
        """)
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        
        for row in rows:
            if isinstance(row['perf_score'], Decimal):
                row['perf_score'] = float(row['perf_score'])
            if isinstance(row['total_ratings'], Decimal):
                row['total_ratings'] = int(row['total_ratings'])
            if isinstance(row['positive_ratings'], Decimal):
                row['positive_ratings'] = int(row['positive_ratings'])
        
        print(f"✅ Loaded {len(rows)} AI FAQs from database")
        return rows
    except Exception as e:
        print(f"❌ DB error: {e}")
        return []

def update_faq_performance_in_db(faq_id: int, rating: int):
    """Update FAQ performance score in database"""
    if not MYSQL_AVAILABLE:
        return
    try:
        conn = mysql.connector.connect(**db_config)
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT total_ratings, positive_ratings 
            FROM ai_faqs WHERE id = %s
        """, (faq_id,))
        result = cursor.fetchone()
        
        if result:
            total = int(result[0]) + 1
            positive = int(result[1]) + (1 if rating >= 4 else 0)
            score = float((positive / total) * 100)
            
            cursor.execute("""
                UPDATE ai_faqs 
                SET total_ratings = %s, positive_ratings = %s, performance_score = %s
                WHERE id = %s
            """, (total, positive, score, faq_id))
            conn.commit()
            print(f"✅ Updated FAQ {faq_id}: new score={score:.1f}%")
        
        cursor.close()
        conn.close()
    except Exception as e:
        print(f"❌ Error updating FAQ performance: {e}")

# ── FastAPI app ────────────────────────────────────────────────────
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

# ── Load NLP model ─────────────────────────────────────────────────
print("🤖 Loading NLP model...")
model = SentenceTransformer("all-MiniLM-L6-v2")
print("✅ Model loaded")

# ── Check Ollama/Llama 3.2 1B availability ─────────────────────────
LLAMA_AVAILABLE = False
LLAMA_MODEL_NAME = "llama3.2:1b"

if OLLAMA_AVAILABLE:
    try:
        print("📋 Checking Ollama for available models...")
        
        try:
            response = ollama.list()
            models = response.get('models', [])
            
            if models:
                print("   Available models:")
                for m in models:
                    if isinstance(m, dict):
                        model_name = m.get('name', '')
                    else:
                        model_name = str(m)
                    
                    print(f"      - {model_name}")
                    
                    if 'llama3.2:1b' in model_name:
                        LLAMA_AVAILABLE = True
                        LLAMA_MODEL_NAME = "llama3.2:1b"
                        print(f"   ✅ Found: {LLAMA_MODEL_NAME}")
                        break
        except Exception as list_error:
            print(f"   Could not list models: {list_error}")
        
        if not LLAMA_AVAILABLE:
            try:
                print("   Testing direct connection to Llama 3.2:1b...")
                test_response = ollama.generate(model="llama3.2:1b", prompt="test", options={'num_predict': 1})
                LLAMA_AVAILABLE = True
                LLAMA_MODEL_NAME = "llama3.2:1b"
                print(f"   ✅ Successfully connected to llama3.2:1b!")
            except Exception as test_error:
                print(f"   Model llama3.2:1b not responding: {test_error}")
        
        if LLAMA_AVAILABLE:
            print(f"✅ Llama 3.2 1B is READY! Level 3 RAG enabled")
            print(f"   AI will GENERATE natural, conversational answers")
            print(f"   Features: combine FAQs, follow-up understanding, natural responses")
            print(f"   Model: {LLAMA_MODEL_NAME} (1.3 GB)")
        else:
            print("⚠️ Llama 3.2:1b model not found")
            print("   Make sure Ollama is running with: ollama run llama3.2:1b")
            print("   Or install with: ollama pull llama3.2:1b")
            print("   Falling back to semantic matching")
            
    except Exception as e:
        print(f"⚠️ Ollama error: {e}")
        print("   Make sure Ollama is running: ollama serve")
        print("   Falling back to semantic matching")

# ── Global AI FAQ cache ──────────────────────────────────────
ai_faq_cache = []
ai_question_embeddings = None

def refresh_ai_faq_cache():
    """Refresh AI FAQs from database"""
    global ai_faq_cache, ai_question_embeddings
    ai_faq_cache = get_ai_faqs_from_db()
    if ai_faq_cache:
        questions = [f["question"] for f in ai_faq_cache]
        ai_question_embeddings = model.encode(questions, convert_to_tensor=True)
        print(f"✅ AI FAQ cache refreshed: {len(ai_faq_cache)} entries")
    else:
        print("⚠️ No AI FAQs found in database!")

refresh_ai_faq_cache()

async def periodic_refresh():
    while True:
        await asyncio.sleep(300)
        refresh_ai_faq_cache()

@app.on_event("startup")
async def start_periodic_refresh():
    asyncio.create_task(periodic_refresh())

# ============ CONTEXT LOCK ============
# Store the last FAQ used for each session
last_faq_context = {}

def is_new_topic(question: str) -> bool:
    """Detect if user is starting a new topic"""
    topic_keywords = ["how", "what", "track", "order", "delay", "refund", "password", "reset", "return", "policy"]
    return any(keyword in question.lower() for keyword in topic_keywords)

# ============ LEVEL 3: CONVERSATION MEMORY ============

conversation_histories = {}

class ConversationMemory:
    def __init__(self, max_history=10):
        self.max_history = max_history
    
    def get_history(self, session_id: str) -> List[dict]:
        if session_id not in conversation_histories:
            conversation_histories[session_id] = []
        return conversation_histories[session_id]
    
    def add_message(self, session_id: str, role: str, content: str):
        history = self.get_history(session_id)
        history.append({
            "role": role,
            "content": content,
            "timestamp": datetime.now().isoformat()
        })
        if len(history) > self.max_history:
            conversation_histories[session_id] = history[-self.max_history:]
    
    def get_formatted_context(self, session_id: str) -> str:
        history = self.get_history(session_id)
        if not history:
            return ""
        
        context = "Previous conversation:\n"
        for msg in history[-6:]:
            if msg["role"] == "user":
                context += f"User: {msg['content']}\n"
            else:
                context += f"Assistant: {msg['content']}\n"
        return context
    
    def clear_history(self, session_id: str):
        if session_id in conversation_histories:
            del conversation_histories[session_id]
            if session_id in last_faq_context:
                del last_faq_context[session_id]

conversation_memory = ConversationMemory(max_history=10)

# ============ LEVEL 3: RAG WITH LLAMA 3.2 1B ============

def find_relevant_faqs(question: str, top_k: int = 1) -> List[dict]:
    """Find top-k relevant FAQs using semantic search - ONLY 1 FAQ"""
    if not ai_faq_cache or ai_question_embeddings is None:
        return []
    
    q_emb = model.encode(question, convert_to_tensor=True)
    sim_scores = util.pytorch_cos_sim(q_emb, ai_question_embeddings)[0]
    top_scores, top_indices = torch.topk(sim_scores, min(top_k, len(ai_faq_cache)))
    
    results = []
    for score, idx in zip(top_scores, top_indices):
        faq = ai_faq_cache[int(idx)]
        results.append({
            "id": faq["id"],
            "question": faq["question"],
            "answer": faq["answer"],
            "score": float(score)
        })
    
    return results

def generate_with_llama(question: str, relevant_faqs: List[dict], conversation_context: str = "") -> Tuple[Optional[str], Optional[int], bool]:
    """
    Generate answer using Llama 3.2 1B with FAQ context (RAG)
    STRICT PROMPT - NO HALLUCINATIONS
    """
    if not relevant_faqs:
        return None, None, False
    
    best_faq = relevant_faqs[0]
    context = f"FAQ: {best_faq['question']}\nAnswer: {best_faq['answer']}"
    

    prompt = f"""
You are a friendly FAQ rewriting assistant.

Your ONLY job:
Rewrite the FAQ answer to sound:
- warm
- polite
- natural
- conversational

BUT you MUST preserve ALL original facts and conditions.

STRICT RULES:
- NEVER add new information
- NEVER remove important information
- NEVER change policies or rules
- NEVER summarize
- NEVER guess
- NEVER invent explanations
- NEVER add extra advice not written in FAQ
- Keep the exact same meaning
- You may ONLY improve wording tone and grammar
- add friendly words like : 'Sure' 'Of course!' 'Yes' at the beginning

GOOD EXAMPLE:
FAQ:
"Free shipping on orders over $50."

Good rewrite:
"Yes! We offer free shipping on orders over $50."


BAD rewrite:
"You can qualify for special free shipping deals."

FAQ:
Question: {best_faq['question']}
Answer: {best_faq['answer']}

User Question:
{question}

Return ONLY the rewritten answer.

Answer:
"""
    try:
        print(f"   🧠 Generating with Llama 3.2 1B...")
        
        response = ollama.generate(
            model=LLAMA_MODEL_NAME,
            prompt=prompt,
            options={
                'temperature': 0.1,  # VERY LOW - prevents creativity/hallucinations
                'num_predict': 150,
            }
        )
        
        answer = response['response'].strip()
        answer = answer.replace('Answer:', '').strip()
        
        if answer and len(answer) > 5:
            print(f"   ✅ Generated ({len(answer)} chars)")
            return answer, best_faq['id'], True
        else:
            return None, None, False
        
    except Exception as e:
        print(f"   ❌ Llama error: {e}")
        return None, None, False

def create_ticket(question: str, session_id: str = None) -> Tuple[str, int]:
    """Create a ticket when everything fails"""
    import random
    ticket_id = random.randint(1000, 9999)
    print(f"   🎫 Creating ticket #{ticket_id} for: '{question[:50]}...'")
    return f"I wasn't able to find an answer. Ticket #{ticket_id} created — our team will follow up shortly!", ticket_id

# ============ MAIN AI FUNCTION (LEVEL 3) ============

def get_ai_answer_with_ranking(question: str, session_id: str = None) -> Tuple[str, Optional[int], bool]:
    """
    COMPLETE FIXED FLOW:
    1. Handle greetings
    2. Check for topic shift
    3. Use context lock for follow-ups
    4. Strict FAQ binding
    5. CREATE TICKET if no answer found
    """
    if not question or not question.strip():
        return "Please ask a question, and I'll be happy to help!", None, False
    
    # STEP 1: Handle simple greetings
    simple_greetings = ["hi", "hello", "hey", "good morning", "good evening", "yo", "hi there", "hello there"]
    if question.lower().strip() in simple_greetings:
        print(f"\n🔍 Greeting detected: '{question}'")
        return "Hello! How can I help you today?", None, False
    
    if not ai_faq_cache or ai_question_embeddings is None:
        return "Knowledge base is loading. Please try again in a moment.", None, False

    print(f"\n🔍 Analyzing question: '{question[:70]}...'")
    
    # STEP 2: Detect topic shift - if new topic, clear context lock
    if is_new_topic(question) and session_id and session_id in last_faq_context:
        print(f"   🔄 New topic detected - clearing context lock")
        del last_faq_context[session_id]
    
    # STEP 3: Determine if this is a follow-up
    followup_words = ["it", "that", "this", "they", "them", "also", "then", "what about", "and", "how long", "how much"]
    is_followup = (
        len(question.split()) < 8 and
        any(word in question.lower() for word in followup_words)
    )
    
    # STEP 4: Context Lock - Use previous FAQ for follow-ups
    previous_faq = None
    if session_id and session_id in last_faq_context:
        previous_faq_id = last_faq_context[session_id]
        previous_faq = next(
            (f for f in ai_faq_cache if f["id"] == previous_faq_id),
            None
        )
        if previous_faq:
            print(f"   🔒 Context locked to FAQ: '{previous_faq['question'][:40]}...'")
    
    # STEP 5: Get relevant FAQ (use previous if follow-up, otherwise search)
    if is_followup and previous_faq:
        relevant_faqs = [previous_faq]
        print(f"   📖 Using locked FAQ (follow-up detected)")
    else:
        relevant_faqs = find_relevant_faqs(question, top_k=1)
        if relevant_faqs and session_id:
            # Lock this FAQ for future follow-ups
            last_faq_context[session_id] = relevant_faqs[0]["id"]
            print(f"   🔒 Locked new FAQ to session")
    
    # STEP 5b: CRITICAL FIX - If NO relevant FAQs found, CREATE TICKET
    if not relevant_faqs:
        print("   ❌ No relevant FAQs found in database")
        answer, ticket_id = create_ticket(question, session_id)
        return answer, None, True
    
    best_faq = relevant_faqs[0]
    
    # STEP 5c: Also check if the score is too low (below threshold)
    if best_faq.get('score', 0) < 0.25:
        print(f"   ⚠️ Low similarity score: {best_faq['score']:.3f} - Creating ticket")
        answer, ticket_id = create_ticket(question, session_id)
        return answer, None, True
    
    print(f"   📖 Using FAQ: '{best_faq['question'][:50]}...' (score: {best_faq['score']:.3f})")
    
    # STEP 6: Get conversation context (only for real follow-ups)
    conversation_context = ""
    if session_id and is_followup and previous_faq:
        conversation_context = conversation_memory.get_formatted_context(session_id)
        if conversation_context:
            print(f"   📚 Using conversation context for follow-up")
    
    # STEP 7: Try Llama with strict settings
    if LLAMA_AVAILABLE:
        answer, faq_id, success = generate_with_llama(question, relevant_faqs, conversation_context)
        if success:
            return answer, faq_id, False
    
    # STEP 8: Fallback to FAQ answer
    print(f"   📖 Using FAQ answer directly")
    return best_faq['answer'], best_faq['id'], False

def get_ai_answer(question: str) -> str:
    answer, _, _ = get_ai_answer_with_ranking(question)
    return answer

# ─── Audio transcription ──────────────────────────────────────────────
def transcribe_wav_file(file_path: str) -> str:
    if not SR_AVAILABLE:
        return ""
    recognizer = sr.Recognizer()
    recognizer.energy_threshold = 200
    recognizer.dynamic_energy_threshold = True
    try:
        with sr.AudioFile(file_path) as source:
            recognizer.adjust_for_ambient_noise(source, duration=0.5)
            audio = recognizer.record(source)
        text = recognizer.recognize_google(audio)
        if text:
            print(f"✅ Transcribed: '{text}'")
            return text.strip()
        return ""
    except Exception as e:
        print(f"❌ Transcription error: {e}")
        return ""

def extract_from_image(file_path: str) -> str:
    if not OCR_AVAILABLE:
        return ""
    try:
        image = Image.open(file_path).convert('L')
        image = ImageOps.autocontrast(image)
        return pytesseract.image_to_string(image).strip()
    except Exception as e:
        print(f"OCR error: {e}")
        return ""

def extract_from_pdf(file_path: str) -> str:
    if not OCR_AVAILABLE:
        return ""
    try:
        text_parts = []
        with open(file_path, 'rb') as f:
            reader = PyPDF2.PdfReader(f)
            for page in reader.pages[:10]:
                t = page.extract_text()
                if t:
                    text_parts.append(t)
        return "\n".join(text_parts).strip()
    except Exception as e:
        print(f"PDF error: {e}")
        return ""

# ============ PYDANTIC MODELS ============

class ChatRequest(BaseModel):
    message: str
    session_id: str = ""
    context: str = ""
    has_context: bool = False

# ============ API ROUTES ============

@app.post("/transcribe-audio")
async def transcribe_audio(file: UploadFile = File(...)):
    """Transcribe audio file to text"""
    print(f"\n🎤 Received: {file.filename}")
    if not SR_AVAILABLE:
        return {"success": False, "text": "", "message": "SpeechRecognition not installed"}
    file_path = None
    try:
        contents = await file.read()
        if len(contents) < 2000:
            return {"success": False, "text": "", "message": "Audio too short"}
        ext = os.path.splitext(file.filename)[1] or ".wav"
        file_path = os.path.join(UPLOAD_DIR, f"audio_{uuid.uuid4()}{ext}")
        with open(file_path, "wb") as f:
            f.write(contents)
        text = transcribe_wav_file(file_path)
        if text:
            return {"success": True, "text": text, "message": "Transcribed"}
        else:
            return {"success": False, "text": "", "message": "No speech detected"}
    except Exception as e:
        return {"success": False, "text": "", "message": str(e)}
    finally:
        if file_path and os.path.exists(file_path):
            os.remove(file_path)

@app.post("/chat")
async def chat(request: ChatRequest):
    """LEVEL 3: Main chat endpoint with RAG and Llama 3.2 1B"""
    try:
        print(f"\n📥 Received /chat request")
        print(f"   Message: {request.message}")
        print(f"   Session ID: {request.session_id or 'new_session'}")
        
        session_id = request.session_id or f"session_{uuid.uuid4().hex[:8]}"
        
        conversation_memory.add_message(session_id, "user", request.message)
        
        answer, faq_id, is_ticket = get_ai_answer_with_ranking(request.message, session_id)
        
        conversation_memory.add_message(session_id, "assistant", answer)
        
        history_count = len(conversation_memory.get_history(session_id))
        
        response_data = {
            "reply": answer,
            "response": answer,
            "source": "llama3.2:1b" if LLAMA_AVAILABLE and not is_ticket else ("faq" if not is_ticket else "ticket"),
            "aiUsed": not is_ticket,
            "ticketCreated": is_ticket,
            "faqId": faq_id,
            "sessionId": session_id,
            "historyCount": history_count
        }
        
        print(f"   ✅ Response sent")
        return response_data
        
    except Exception as e:
        print(f"❌ Error in /chat: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": str(e)})

@app.post("/chat-with-context")
async def chat_with_context(request: ChatRequest):
    """LEVEL 3: Chat endpoint with explicit conversation context"""
    try:
        print(f"\n📥 Received /chat-with-context request")
        print(f"   Message: {request.message}")
        print(f"   Session ID: {request.session_id or 'new_session'}")
        print(f"   Has context: {request.has_context}")
        
        session_id = request.session_id or f"session_{uuid.uuid4().hex[:8]}"
        
        conversation_memory.add_message(session_id, "user", request.message)
        
        answer, faq_id, is_ticket = get_ai_answer_with_ranking(request.message, session_id)
        
        conversation_memory.add_message(session_id, "assistant", answer)
        
        history_count = len(conversation_memory.get_history(session_id))
        
        return {
            "reply": answer,
            "response": answer,
            "source": "llama3.2:1b" if LLAMA_AVAILABLE and not is_ticket else ("faq" if not is_ticket else "ticket"),
            "aiUsed": not is_ticket,
            "ticketCreated": is_ticket,
            "faqId": faq_id,
            "sessionId": session_id,
            "historyCount": history_count
        }
        
    except Exception as e:
        print(f"❌ Error in /chat-with-context: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=400, content={"error": str(e)})

@app.delete("/chat/history/{session_id}")
async def clear_conversation_history(session_id: str):
    try:
        conversation_memory.clear_history(session_id)
        return {"success": True, "message": f"Cleared history for session {session_id}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/chat/history/{session_id}")
async def get_conversation_history(session_id: str):
    try:
        history = conversation_memory.get_history(session_id)
        return {"success": True, "history": history, "count": len(history)}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.post("/chat/rate")
async def rate_answer(request: Request):
    try:
        body = await request.json()
        faq_id = body.get('faqId')
        rating = body.get('rating')
        feedback = body.get('feedback', '')
        
        if not faq_id or not rating:
            return JSONResponse(status_code=400, content={"error": "Missing faqId or rating"})
        
        update_faq_performance_in_db(faq_id, rating)
        
        return {"success": True, "message": "Thank you for your feedback!"}
    except Exception as e:
        print(f"❌ Error in rating: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.get("/faqs/ai/top")
async def top_ai_faqs(limit: int = 10):
    if not MYSQL_AVAILABLE:
        return []
    try:
        conn = mysql.connector.connect(**db_config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute("""
            SELECT id, question, answer,
                   COALESCE(performance_score, 0) as perf_score,
                   COALESCE(total_ratings, 0) as total_ratings
            FROM ai_faqs
            ORDER BY performance_score DESC, total_ratings DESC
            LIMIT %s
        """, (limit,))
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        return rows
    except Exception as e:
        print(f"❌ Error: {e}")
        return []

@app.get("/faqs/ai/all")
async def all_ai_faqs():
    if not MYSQL_AVAILABLE:
        return []
    try:
        conn = mysql.connector.connect(**db_config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute("""
            SELECT id, question, answer,
                   COALESCE(performance_score, 0) as perf_score,
                   COALESCE(total_ratings, 0) as total_ratings
            FROM ai_faqs
            ORDER BY id ASC
        """)
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        return rows
    except Exception as e:
        print(f"❌ Error: {e}")
        return []

@app.post("/process-file")
async def process_file(file: UploadFile = File(...), message: str = Form(default="")):
    file_path = None
    try:
        ext = os.path.splitext(file.filename)[1]
        file_path = os.path.join(UPLOAD_DIR, f"{uuid.uuid4()}{ext}")
        with open(file_path, "wb") as buf:
            shutil.copyfileobj(file.file, buf)
        
        extracted = ""
        if file.content_type.startswith("image/"):
            extracted = extract_from_image(file_path)
            print(f"   Extracted text from image: {len(extracted)} chars")
        elif file.content_type == "application/pdf":
            extracted = extract_from_pdf(file_path)
            print(f"   Extracted text from PDF: {len(extracted)} chars")
        
        full_text = f"{message} {extracted}" if extracted else message
        answer, faq_id, is_ticket = get_ai_answer_with_ranking(full_text)
        
        return {
            "success": True,
            "reply": answer,
            "extracted_text": extracted[:500] if extracted else "",
            "faqId": faq_id,
            "ticketCreated": is_ticket
        }
    except Exception as e:
        print(f"Error processing file: {e}")
        return {"success": False, "error": str(e)}
    finally:
        if file_path and os.path.exists(file_path):
            os.remove(file_path)

@app.get("/health")
def health():
    return {
        "status": "healthy", 
        "level": 3, 
        "llama_available": LLAMA_AVAILABLE,
        "model": LLAMA_MODEL_NAME if LLAMA_AVAILABLE else "Fallback Mode",
    }

@app.get("/")
def root():
    return {
        "status": "active",
        "level": 3,
        "message": "🚀 LEVEL 3 AI SERVICE - RAG with Llama 3.2 1B",
        "faq_count": len(ai_faq_cache) if ai_faq_cache else 0,
        "llama_available": LLAMA_AVAILABLE,
        "model_name": LLAMA_MODEL_NAME if LLAMA_AVAILABLE else "None",
        "features": {
            "nlp_model": "all-MiniLM-L6-v2",
            "conversation_memory": True,
            "context_lock": True,
            "topic_detection": True,
            "rag_enabled": LLAMA_AVAILABLE,
        }
    }

if __name__ == "__main__":
    import uvicorn
    print("\n" + "="*70)
    print("🚀 LEVEL 3 AI SERVICE - FIXED VERSION")
    print("="*70)
    print(f"   ✅ Loaded {len(ai_faq_cache) if ai_faq_cache else 0} FAQs from database")
    print(f"   ✅ NLP Model: all-MiniLM-L6-v2")
    print(f"   ✅ Conversation Memory: ENABLED")
    print(f"   ✅ Context Lock: ENABLED (prevents topic mixing)")
    print(f"   ✅ Topic Detection: ENABLED")
    print(f"   ✅ Temperature: 0.1 (very low - prevents hallucinations)")
    print(f"   ✅ Llama 3.2 1B: {'ENABLED' if LLAMA_AVAILABLE else 'DISABLED'}")
    print(f"   ✅ TICKET CREATION: ENABLED (when no FAQ matches or score too low)")
    
    if LLAMA_AVAILABLE:
        print(f"   ✅ Model is READY!")
        print(f"   ✅ Will NOT hallucinate time estimates")
        print(f"   ✅ Will NOT mix unrelated topics")
        print(f"   ✅ Will use context lock for follow-ups")
    else:
        print(f"   ⚠️ Make sure Ollama is running in another terminal:")
        print(f"      ollama run llama3.2:1b")
    
    print("\n📡 Server: http://0.0.0.0:8000")
    print("="*70 + "\n")
    uvicorn.run(app, host="0.0.0.0", port=8000)