// js/notes.js
// Este arquivo contém a lógica para a funcionalidade de anotações.

(function(){
  // ATENÇÃO: Substitua 'SEU_USER_ID' pelo seu User ID real do EmailJS.
  // Você pode encontrá-lo na seção 'API Keys' do seu painel EmailJS.
  emailjs.init("SEU_USER_ID");
})();

const notesBtn = document.getElementById("notes-btn");
const notesModal = document.getElementById("notes-modal");
const closeNotesBtn = document.getElementById("close-notes-btn");
const saveNotesBtn = document.getElementById("save-notes-btn");
const notesText = document.getElementById("notes-text");

if (notesBtn) {
    notesBtn.addEventListener("click", () => {
        const saved = localStorage.getItem("pauta_notes") || "";
        notesText.value = saved;
        notesModal.classList.remove("hidden");
    });
}

if(closeNotesBtn) {
    closeNotesBtn.addEventListener("click", () => {
        notesModal.classList.add("hidden");
    });
}

if(saveNotesBtn) {
    saveNotesBtn.addEventListener("click", () => {
        localStorage.setItem("pauta_notes", notesText.value);
        alert("Anotação salva!");
        notesModal.classList.add("hidden");
    });
}


async function sendNotesByEmail() {
  const notes = localStorage.getItem("pauta_notes") || "";
  if (!notes) return;

  // ATENÇÃO: Substitua os valores abaixo pelos seus IDs do EmailJS.
  const serviceID = 'SEU_SERVICE_ID'; // Ex: 'service_abcde12'
  const templateID = 'SEU_TEMPLATE_ID'; // Ex: 'template_fghij34'
  const emailTo = 'SEU_EMAIL@dominio.com'; // O e-mail para onde as anotações serão enviadas

  try {
    await emailjs.send(serviceID, templateID, {
      message: notes,
      email_to: emailTo
    });
    console.log("Anotações enviadas por e-mail!");
  } catch (err) {
    console.error("Erro ao enviar email:", err);
    alert("Falha ao enviar anotações por e-mail. Verifique suas configurações do EmailJS.");
  }
}

// Integração com o botão de fechar pauta para enviar as anotações
const closePautaBtn = document.getElementById("close-pauta-btn");
if (closePautaBtn) {
  closePautaBtn.addEventListener("click", async () => {
    // Esta função será chamada ANTES da lógica de fechar a pauta ser executada.
    await sendNotesByEmail();
  });
}
