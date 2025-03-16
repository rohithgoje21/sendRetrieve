const send = async () => {
    const text = document.getElementById("textInput").value;
    const fileInput = document.getElementById("fileInput");
    const file = fileInput.files[0];

    if (!text && !file) {
        alert("Please enter text or upload a file.");
        return;
    }

    const formData = new FormData();
    if (text) formData.append("text", text);
    if (file) formData.append("file", file);

    const response = await fetch("/send", {
        method: "POST",
        body: formData,
    });

    const result = await response.json();
    const generatedIdContainer = document.getElementById("generatedIdContainer");
    const generatedIdElement = document.getElementById("generatedId");

    if (result.id) {
        generatedIdElement.innerHTML = result.id;
        generatedIdContainer.style.display = "flex";
    } else {
        alert("Error sending data.");
        generatedIdContainer.style.display = "none";
    }
};

const retrieve = async () => {
    const id = document.getElementById("retrieveId").value;
    if (!id || id.length !== 4) {
        alert("Please enter a valid 4-digit ID.");
        return;
    }

    const response = await fetch(`/retrieve/${id}`);
    const result = await response.json();

    const retrievedTextElement = document.getElementById("retrievedText");
    const retrievedFileElement = document.getElementById("retrievedFile");
    const retrievedContainer = document.getElementById("retrievedContainer");

    if (result.text) {
        retrievedTextElement.innerText = result.text;
        retrievedTextElement.style.display = "block";
    } else {
        retrievedTextElement.style.display = "none";
    }

    if (result.fileUrl) {
        const fileName = result.fileUrl.split('/').pop();
        retrievedFileElement.href = result.fileUrl;
        retrievedFileElement.innerText = fileName;
        retrievedFileElement.style.display = "block";
    } else {
        retrievedFileElement.style.display = "none";
    }

    if (result.text || result.fileUrl) {
        retrievedContainer.style.display = "block";
    } else {
        alert("Data not found or expired.");
        retrievedContainer.style.display = "none";
    }
};

function copyText(elementId, button) {
    const textToCopy = document.getElementById(elementId).textContent;
    navigator.clipboard.writeText(textToCopy).then(() => {
        button.textContent = "Copied!";

        setTimeout(() => {
            button.textContent = "Copy";
        }, 1000);
    }).catch(err => {
        console.error("Failed to copy: ", err);
    });
}

