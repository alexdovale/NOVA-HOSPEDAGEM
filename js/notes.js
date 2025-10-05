document.addEventListener('DOMContentLoaded', () => {
    const notesBtn = document.getElementById("notes-btn");
    const notesModal = document.getElementById("notes-modal");
    const closeNotesBtn = document.getElementById("close-notes-btn");
    const saveNotesBtn = document.getElementById("save-notes-btn");
    const notesText = document.getElementById("notes-text");

    const getNotesKey = () => {
        const pautaId = document.body.dataset.currentPautaId;
        return pautaId ? `pauta_notes_${pautaId}` : null;
    };

    const showNotification = (message, type = 'info') => {
        const colors = { info: 'blue', error: 'red', success: 'green' };
        const notification = document.createElement('div');
        notification.className = `fixed top-5 right-5 bg-${colors[type]}-500 text-white py-3 px-6 rounded-lg shadow-lg z-[100] transition-transform transform translate-x-full`;
        notification.textContent = message;
        document.body.appendChild(notification);
        requestAnimationFrame(() => notification.classList.remove('translate-x-full'));
        setTimeout(() => {
            notification.classList.add('translate-x-full');
            notification.addEventListener('transitionend', () => notification.remove());
        }, 3000);
    };

    if (notesBtn) {
        notesBtn.addEventListener("click", () => {
            const key = getNotesKey();
            if (!key) {
                showNotification("Selecione uma pauta para ver as anotações.", "error");
                return;
            }
            const saved = localStorage.getItem(key) || "";
            notesText.value = saved;
            notesModal.classList.remove("hidden");
        });
    }

    if (closeNotesBtn) {
        closeNotesBtn.addEventListener("click", () => {
            notesModal.classList.add("hidden");
        });
    }

    if (saveNotesBtn) {
        saveNotesBtn.addEventListener("click", () => {
            const key = getNotesKey();
            if (!key) {
                showNotification("Não foi possível salvar. Pauta não identificada.", "error");
                return;
            }
            localStorage.setItem(key, notesText.value);
            showNotification("Anotação salva com sucesso!");
            notesModal.classList.add("hidden");
        });
    }
});

