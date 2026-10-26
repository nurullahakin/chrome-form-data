// Popup JavaScript
let currentFormData = null;

document.addEventListener('DOMContentLoaded', function() {
  const scanBtn = document.getElementById('scanBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  
  scanBtn.addEventListener('click', extractFormData);
  cancelBtn.addEventListener('click', viewSavedForms);

  const importFile = document.getElementById('importFile');
  document.getElementById('exportBtn').addEventListener('click', exportSavedForms);
  document.getElementById('importBtn').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => {
    if (importFile.files[0]) {
      importSavedForms(importFile.files[0]);
    }
    importFile.value = '';
  });

  // Automatically load saved forms list on popup open
  viewSavedForms();
});

function hideSaveSection() {
  const saveSection = document.getElementById('saveSection');
  saveSection.classList.add('hidden');
}

async function extractFormData() {
  try {
    // Check if chrome.scripting is available
    if (!chrome.scripting) {
      showStatus('Error: Extension API not available. Please reload the extension.', 'error');
      document.getElementById('formDataContainer').innerHTML = '<p class="text-gray-500">Please reload the extension and try again.</p>';
      return;
    }
    
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab || !tab.id) {
      showStatus('Error: No active tab found', 'error');
      document.getElementById('formDataContainer').innerHTML = '<p class="text-gray-500">No active tab found.</p>';
      return;
    }
    
    // Check if the tab URL is accessible
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://')) {
      showStatus('Cannot access browser internal pages', 'error');
      document.getElementById('formDataContainer').innerHTML = '<p class="text-gray-500">Cannot extract forms from browser internal pages.</p>';
      return;
    }
    
    // Inject and execute the content script
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: extractFormsFromPage
    });
    
    if (results && results[0] && results[0].result) {
      currentFormData = {
        url: tab.url,
        title: tab.title,
        timestamp: new Date().toISOString(),
        forms: results[0].result
      };
      
      displayFormData(currentFormData);
      hideSaveSection();
      showStatus(`Found ${currentFormData.forms.length} form(s)`, 'info');
    } else {
      document.getElementById('formDataContainer').innerHTML = '<p class="text-gray-500">No forms found on this page.</p>';
      showStatus('No forms found on this page', 'info');
      hideSaveSection();
    }
  } catch (error) {
    console.error('Error extracting form data:', error);
    document.getElementById('formDataContainer').innerHTML = `<p class="text-red-600">Error: ${error.message}</p>`;
    showStatus('Error: ' + error.message, 'error');
  }
}

function extractFormsFromPage() {
  // Helper function to generate XPath for an element
  function generateXPath(element) {
    if (element.id) {
      return `//*[@id="${element.id}"]`;
    }
    
    const parts = [];
    let el = element;
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      let index = 0;
      let sibling = el.previousSibling;
      while (sibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === el.nodeName) {
          index++;
        }
        sibling = sibling.previousSibling;
      }
      
      const tagName = el.nodeName.toLowerCase();
      const pathIndex = index ? `[${index + 1}]` : '';
      parts.unshift(tagName + pathIndex);
      
      el = el.parentNode;
    }
    
    return parts.length ? '/' + parts.join('/') : '';
  }
  
  // Helper function to generate CSS selector for an element
  function generateSelector(element) {
    if (element.id) {
      return `#${element.id}`;
    }
    
    if (element.name) {
      return `${element.tagName.toLowerCase()}[name="${element.name}"]`;
    }
    
    // Generate a selector based on attributes
    let selector = element.tagName.toLowerCase();
    if (element.type) {
      selector += `[type="${element.type}"]`;
    }
    if (element.className) {
      selector += '.' + element.className.split(' ').join('.');
    }
    
    return selector;
  }

  // Helper function to find a human-readable label for an element
  function findLabel(element) {
    const clean = text => (text || '').replace(/\s+/g, ' ').trim();

    // Label explicitly associated with an element
    function associatedLabel(el) {
      // aria-labelledby takes precedence, as in the accessibility tree
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = clean(labelledBy.split(/\s+/)
          .map(id => document.getElementById(id)?.textContent)
          .join(' '));
        if (text) return text;
      }

      const ariaLabel = clean(el.getAttribute('aria-label'));
      if (ariaLabel) return ariaLabel;

      // <label for="..."> and wrapping <label>, excluding the control's own text
      for (const label of el.labels || []) {
        const copy = label.cloneNode(true);
        copy.querySelectorAll('input, textarea, select').forEach(e => e.remove());
        const text = clean(copy.textContent);
        if (text) return text;
      }

      return '';
    }

    const ownLabel = associatedLabel(element);
    if (ownLabel) return ownLabel;

    // Custom control (e.g. <button role="combobox">) rendered next to a hidden native
    // input; the label is associated with the custom control instead
    for (const sibling of [element.previousElementSibling, element.nextElementSibling]) {
      if (sibling && sibling.hasAttribute('role')) {
        const text = associatedLabel(sibling);
        if (text) return text;
      }
    }

    // Sibling <label>; checkboxes and radios usually have it after
    const isToggle = element.type === 'checkbox' || element.type === 'radio';
    const directions = isToggle
      ? ['nextElementSibling', 'previousElementSibling']
      : ['previousElementSibling', 'nextElementSibling'];
    for (const direction of directions) {
      let sibling = element[direction];
      while (sibling) {
        // Stop at another control, since a label beyond it belongs to that control
        if (sibling.matches('input, textarea, select')) break;
        // Skip labels bound to another form control, but accept ones bound to a custom
        // control (e.g. <button role="checkbox"> next to a hidden native input)
        const boundToOtherControl = sibling.control && sibling.control !== element &&
          sibling.control.matches('input, textarea, select');
        if (sibling.tagName === 'LABEL' && !boundToOtherControl) {
          const text = clean(sibling.textContent);
          if (text) return text;
        }
        sibling = sibling[direction];
      }
    }

    return clean(element.placeholder) || clean(element.title);
  }

  const forms = document.querySelectorAll('form');
  const formDataArray = [];
  
  forms.forEach((form, formIndex) => {
    // Use getAttribute instead of the DOM property: a named form control (e.g. an
    // input named "name"/"id"/"action"/"method") shadows these properties on the
    // form element, which would otherwise leak a non-serializable element here.
    const formData = {
      formIndex: formIndex,
      formId: form.getAttribute('id') || `form-${formIndex}`,
      formName: form.getAttribute('name') || '',
      action: form.getAttribute('action') || '',
      method: form.getAttribute('method') || 'get',
      fields: []
    };
    
    // Get all input fields
    const inputs = form.querySelectorAll('input, textarea, select');
    
    // Convert to array and sort by visual position (top to bottom, left to right)
    const inputsArray = Array.from(inputs);
    inputsArray.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      
      // Sort by vertical position first (top to bottom)
      if (Math.abs(rectA.top - rectB.top) > 5) {
        return rectA.top - rectB.top;
      }
      
      // If on same row (within 5px), sort by horizontal position (left to right)
      return rectA.left - rectB.left;
    });
    
    inputsArray.forEach((input, inputIndex) => {
      const fieldData = {
        type: input.type || input.tagName.toLowerCase(),
        name: input.name || '',
        id: input.id || '',
        label: findLabel(input),
        value: '',
        selector: generateSelector(input),
        xpath: generateXPath(input)
      };
      
      // Get value based on input type
      if (input.type === 'checkbox' || input.type === 'radio') {
        fieldData.checked = input.checked;
        fieldData.value = input.value;
      } else if (input.tagName.toLowerCase() === 'select') {
        fieldData.value = input.value;
        fieldData.selectedIndex = input.selectedIndex;
      } else if (input.type !== 'file') {
        fieldData.value = input.value;
      }
      
      formData.fields.push(fieldData);
    });
    
    if (formData.fields.length > 0) {
      formDataArray.push(formData);
    }
  });
  
  return formDataArray;
}

function fieldHeadingHtml(field) {
  const fieldIdentifier = field.name || field.id || `${field.type} field`;
  const fieldLabel = field.label
    ? field.label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    : '';
  return `${fieldLabel || fieldIdentifier}${fieldLabel ? ` <span class="font-normal text-gray-500">${fieldIdentifier}</span>` : ''} (${field.type})`;
}

function displayFormData(data) {
  const container = document.getElementById('formDataContainer');
  container.innerHTML = '';
  hideSaveSection();
  
  // Hide scan button when on scan page
  document.querySelector('.bottom-actions').classList.add('hidden');
  
  // Display URL as editable input
  const urlSection = document.createElement('div');
  urlSection.className = 'url-section mb-[15px] flex items-center gap-2 rounded-[4px] border border-sky-200 bg-sky-50 p-3';
  urlSection.innerHTML = `
    <strong class="shrink-0 text-[13px] text-gray-800">Page URL:</strong>
    <input type="text" id="pageUrl" class="url-input box-border w-full max-w-full rounded-[3px] border border-sky-200 bg-white px-2 py-1.5 text-xs text-blue-700 focus:border-green-600 focus:outline-none" value="${data.url}">
  `;
  container.appendChild(urlSection);
  
  if (!data.forms || data.forms.length === 0) {
    container.innerHTML += '<p class="text-gray-500">No forms found</p>';
    return;
  }
  
  data.forms.forEach((form, formIndex) => {
    const formSection = document.createElement('div');
    formSection.className = 'form-section mb-[15px] rounded-[4px] border border-gray-300 bg-gray-50 p-[15px]';
    formSection.dataset.formIndex = formIndex;
    
    const formTitle = form.formName || form.formId || `Form ${form.formIndex + 1}`;
    let html = `
      <div class="form-name-container mb-3 flex items-center gap-2">
        <label class="shrink-0 text-[13px] font-bold text-gray-800">Form Name</label>
        <input type="text" class="form-name-input box-border w-full max-w-full rounded-[3px] border border-gray-300 bg-white px-2 py-1.5 text-[13px] font-bold text-gray-800 focus:border-green-600 focus:outline-none" data-form-index="${formIndex}" value="${formTitle}" placeholder="Form Name">
      </div>
    `;
    
    if (form.fields.length === 0) {
      html += '<p class="text-gray-500">No fields found</p>';
    } else {
      form.fields.forEach((field, fieldIndex) => {
        const dataAttr = `data-form="${formIndex}" data-field="${fieldIndex}"`;
        const isPasswordField = field.type === 'password';
        const fieldItemClass = isPasswordField
          ? 'field-item relative my-2 rounded-[4px] border border-red-300 bg-red-50 p-2 shadow-sm text-[13px]'
          : 'field-item relative my-2 rounded-[4px] border border-gray-300 bg-white p-2 shadow-sm text-[13px]';
        
        html += `<div class="${fieldItemClass}" ${dataAttr}>`;
        html += `<button class="delete-field-btn absolute right-2 top-2 cursor-pointer rounded-[3px] border-0 bg-red-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-red-700" ${dataAttr}>Delete</button>`;
        html += `<div class="field-name mb-[3px] font-bold ${isPasswordField ? 'text-red-700' : 'text-gray-800'}" ${dataAttr}>${fieldHeadingHtml(field)}</div>`;
        
        // Show selector information as editable inputs
        html += `<div class="field-selector my-1.5 box-border rounded-[3px] bg-gray-100 p-1.5 text-[11px] text-gray-600">`;
        html += `<div class="selector-row mb-1 flex items-center gap-1">`;
        html += `<span class="selector-label min-w-[55px] text-[11px] font-bold text-gray-600">XPath:</span>`;
        html += `<input type="text" class="selector-input xpath-input min-w-0 max-w-full flex-1 rounded-[2px] border border-gray-300 bg-white px-1.5 py-0.5 font-mono text-[10px] focus:border-green-600 focus:outline-none" value="${(field.xpath || '').replace(/"/g, '&quot;')}" ${dataAttr} data-selector-type="xpath" placeholder="XPath selector">`;
        html += `</div>`;
        html += `<div class="selector-row flex items-center gap-1">`;
        html += `<span class="selector-label min-w-[55px] text-[11px] font-bold text-gray-600">CSS:</span>`;
        html += `<input type="text" class="selector-input css-input min-w-0 max-w-full flex-1 rounded-[2px] border border-gray-300 bg-white px-1.5 py-0.5 font-mono text-[10px] focus:border-green-600 focus:outline-none" value="${(field.selector || '').replace(/"/g, '&quot;')}" ${dataAttr} data-selector-type="selector" placeholder="CSS selector">`;
        html += `</div>`;
        html += `</div>`;
        
        if (field.type === 'checkbox' || field.type === 'radio') {
          html += `
            <label class="checkbox-label mt-1 flex cursor-pointer items-center">
              <input type="checkbox" class="mr-1 cursor-pointer" ${field.checked ? 'checked' : ''} ${dataAttr}>
              ${field.checked ? 'Checked' : 'Unchecked'}
            </label>
          `;
        } else if (field.type === 'textarea') {
          html += `<textarea rows="3" class="mt-1 box-border w-full max-w-full rounded-[3px] border border-gray-300 px-2 py-1.5 text-[13px] focus:border-green-600 focus:outline-none" ${dataAttr}>${field.value || ''}</textarea>`;
        } else if (isPasswordField) {
          html += `
            <div class="mt-1 flex items-center gap-2">
              <input type="text" class="password-value-input box-border min-w-0 flex-1 rounded-[3px] border border-red-300 bg-white px-2 py-1.5 text-[13px] focus:border-red-500 focus:outline-none" value="${(field.value || '').replace(/"/g, '&quot;')}" ${dataAttr} placeholder="Empty">
              <button class="clear-password-btn shrink-0 cursor-pointer rounded-[3px] border-0 bg-red-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-red-700" ${dataAttr}>Clear</button>
            </div>
          `;
        } else if (field.type !== 'file') {
          const inputType = field.type === 'password' ? 'text' : 'text';
          html += `<input type="${inputType}" class="mt-1 box-border w-full max-w-full rounded-[3px] border border-gray-300 px-2 py-1.5 text-[13px] focus:border-green-600 focus:outline-none" value="${(field.value || '').replace(/"/g, '&quot;')}" ${dataAttr} placeholder="Empty">`;
        } else {
          html += `<div class="field-value break-words text-gray-600"><em>File field - not captured</em></div>`;
        }
        
        html += `</div>`;
      });
    }

    html += `
      <div class="mt-4 text-left">
        ${data.editMode
          ? `<button class="update-form-btn mr-2.5 inline-block cursor-pointer rounded-[4px] border-0 bg-sky-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-sky-700">Update Form Data</button>
             <button class="rescan-labels-btn mr-2.5 inline-block cursor-pointer rounded-[4px] border border-gray-300 bg-white px-3 py-1.5 text-xs font-bold text-gray-700 hover:bg-gray-100" title="Re-read field labels from the current tab">Rescan Labels</button>`
          : `<button class="save-form-btn mr-2.5 inline-block cursor-pointer rounded-[4px] border-0 bg-sky-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-sky-700" data-form-index="${formIndex}">Save This Form</button>`}
        <button class="cancel-form-btn inline-block cursor-pointer rounded-[4px] border-0 bg-gray-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-gray-600">Cancel</button>
      </div>
    `;
    
    formSection.innerHTML = html;
    container.appendChild(formSection);
  });
  
  const saveFormButtons = container.querySelectorAll('.save-form-btn');
  saveFormButtons.forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      saveFormData(parseInt(this.dataset.formIndex));
    });
  });

  const updateFormButtons = container.querySelectorAll('.update-form-btn');
  updateFormButtons.forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      updateFormData();
    });
  });

  container.querySelectorAll('.rescan-labels-btn').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      rescanLabels();
    });
  });

  const cancelFormButtons = container.querySelectorAll('.cancel-form-btn');
  cancelFormButtons.forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      viewSavedForms();
    });
  });

  const clearPasswordButtons = container.querySelectorAll('.clear-password-btn');
  clearPasswordButtons.forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      const formIndex = this.dataset.form;
      const fieldIndex = this.dataset.field;
      const passwordInput = document.querySelector(`.password-value-input[data-form="${formIndex}"][data-field="${fieldIndex}"]`);

      if (passwordInput) {
        passwordInput.value = '';
      }
    });
  });
  
  // Add delete button event listeners
  const deleteButtons = container.querySelectorAll('.delete-field-btn');
  deleteButtons.forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      const formIndex = this.dataset.form;
      const fieldIndex = this.dataset.field;
      const fieldItem = document.querySelector(`.field-item[data-form="${formIndex}"][data-field="${fieldIndex}"]`);
      
      if (fieldItem) {
        fieldItem.remove();
      }
    });
  });
}

async function saveFormData(formIndexToSave = null) {
  if (!currentFormData) {
    showStatus('No form data to save', 'error');
    return;
  }
  
  try {
    // Update URL from the input field
    const urlInput = document.getElementById('pageUrl');
    if (urlInput) {
      currentFormData.url = urlInput.value;
    }
    
    // Update form names from inputs
    const formNameInputs = document.querySelectorAll('.form-name-input');
    formNameInputs.forEach(input => {
      const formIndex = parseInt(input.dataset.formIndex);
      if (currentFormData.forms[formIndex]) {
        currentFormData.forms[formIndex].formName = input.value;
      }
    });
    
    // Collect only visible fields (deleted ones are removed from DOM)
    const visibleInputs = document.querySelectorAll('input[data-form], textarea[data-form]');
    const visibleFieldsSet = new Set();
    
    visibleInputs.forEach(input => {
      const formIndex = parseInt(input.dataset.form);
      const fieldIndex = parseInt(input.dataset.field);
      visibleFieldsSet.add(`${formIndex}-${fieldIndex}`);
      
      if (currentFormData.forms[formIndex] && currentFormData.forms[formIndex].fields[fieldIndex]) {
        const field = currentFormData.forms[formIndex].fields[fieldIndex];
        
        // Update selectors if it's a selector input
        if (input.dataset.selectorType) {
          if (input.dataset.selectorType === 'xpath') {
            field.xpath = input.value;
          } else if (input.dataset.selectorType === 'selector') {
            field.selector = input.value;
          }
        } else if (input.type === 'checkbox') {
          field.checked = input.checked;
        } else {
          field.value = input.value;
        }
      }
    });
    
    // Remove fields that are no longer visible from currentFormData
    currentFormData.forms.forEach((form, formIndex) => {
      form.fields = form.fields.filter((field, fieldIndex) => {
        return visibleFieldsSet.has(`${formIndex}-${fieldIndex}`);
      });
    });
    
    // Get existing saved forms
    const result = await chrome.storage.local.get(['savedForms']);
    const savedForms = result.savedForms || [];
    
    const formsToSave = Number.isInteger(formIndexToSave)
      ? [currentFormData.forms[formIndexToSave]].filter(Boolean)
      : currentFormData.forms;

    if (formsToSave.length === 0) {
      showStatus('No form data to save', 'error');
      return;
    }

    // Add the selected form data
    savedForms.push({
      url: currentFormData.url,
      title: currentFormData.title,
      timestamp: new Date().toISOString(),
      forms: formsToSave
    });
    
    // Save back to storage
    await chrome.storage.local.set({ savedForms: savedForms });
    
    showStatus('Form data saved successfully!', 'success');
    
    // Return to saved forms list
    setTimeout(() => {
      viewSavedForms();
    }, 500);
  } catch (error) {
    console.error('Error saving form data:', error);
    showStatus('Error saving: ' + error.message, 'error');
  }
}

function showStatus(message, type) {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = message;
  const statusClasses = {
    success: 'mb-2.5 rounded-[4px] border border-green-200 bg-green-100 p-2.5 text-center text-[13px] text-green-900',
    error: 'mb-2.5 rounded-[4px] border border-red-200 bg-red-100 p-2.5 text-center text-[13px] text-red-900',
    info: 'mb-2.5 rounded-[4px] border border-sky-200 bg-sky-100 p-2.5 text-center text-[13px] text-sky-900'
  };
  statusDiv.className = statusClasses[type] || statusClasses.info;
  
  // Clear status after 3 seconds
  setTimeout(() => {
    statusDiv.textContent = '';
    statusDiv.className = 'hidden';
  }, 3000);
}

async function viewSavedForms() {
  try {
    const result = await chrome.storage.local.get(['savedForms']);
    const savedForms = result.savedForms || [];
    
    // Show scan button when viewing saved forms
    document.querySelector('.bottom-actions').classList.remove('hidden');
    
    const container = document.getElementById('formDataContainer');
    hideSaveSection();
    
    if (savedForms.length === 0) {
      container.innerHTML = '<p class="info-text px-5 py-[30px] text-center text-sm text-gray-600">No saved forms yet. Scan a page and save form data to see it here.</p>';
      return;
    }
    
    let tableHtml = `
      <table class="saved-forms-table w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th class="sticky top-0 w-6 bg-green-600 px-1 py-2.5"></th>
            <th class="sticky top-0 bg-green-600 px-2 py-2.5 text-left font-bold text-white">URL</th>
            <th class="sticky top-0 bg-green-600 px-2 py-2.5 text-left font-bold text-white">Form Name</th>
            <th class="sticky top-0 bg-green-600 px-2 py-2.5 text-left font-bold text-white">Fields</th>
            <th class="sticky top-0 bg-green-600 px-2 py-2.5 text-left font-bold text-white">Created</th>
            <th class="sticky top-0 bg-green-600 px-2 py-2.5 text-left font-bold text-white">Actions</th>
          </tr>
        </thead>
        <tbody>
    `;
    
    savedForms.forEach((formData, entryIndex) => {
      formData.forms.forEach((form, formIndex) => {
        const fieldCount = form.fields.length;
        const formName = form.formName || form.formId || `Form ${form.formIndex + 1}`;
        // ISO-style local date and time, e.g. 2026-10-26 14:30
        const created = new Date(formData.timestamp);
        const pad = n => String(n).padStart(2, '0');
        const date = `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())} ${pad(created.getHours())}:${pad(created.getMinutes())}`;
        
        tableHtml += `
          <tr class="form-row hover:bg-gray-100" data-entry="${entryIndex}" data-form="${formIndex}">
            <td class="drag-handle w-6 cursor-grab select-none border-b border-gray-300 px-1 py-2 text-center align-middle text-gray-400 hover:text-gray-700" title="Drag to reorder">⠿</td>
            <td class="url-cell max-w-[150px] overflow-hidden text-ellipsis whitespace-nowrap border-b border-gray-300 px-2 py-2 align-middle text-[11px] text-blue-700" title="${formData.url}">${/^https?:\/\//i.test(formData.url) ? `<a href="${formData.url}" class="url-link text-blue-700 hover:underline">${formData.url}</a>` : formData.url}</td>
            <td class="max-w-[150px] overflow-hidden text-ellipsis whitespace-nowrap border-b border-gray-300 px-2 py-2 align-middle" title="${formName}">${formName}</td>
            <td class="border-b border-gray-300 px-2 py-2 align-middle">${fieldCount} field${fieldCount !== 1 ? 's' : ''}</td>
            <td class="date-cell whitespace-nowrap border-b border-gray-300 px-2 py-2 align-middle text-[11px] text-gray-600">${date}</td>
            <td class="actions-cell whitespace-nowrap border-b border-gray-300 px-2 py-2 align-middle">
              <button class="table-btn fill-btn mx-0.5 cursor-pointer rounded-[3px] border-0 bg-green-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-green-700" data-entry="${entryIndex}" data-form="${formIndex}">Fill</button>
              <button class="table-btn view-btn mx-0.5 cursor-pointer rounded-[3px] border-0 bg-sky-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-sky-700" data-entry="${entryIndex}" data-form="${formIndex}">View</button>
              <button class="table-btn edit-btn mx-0.5 cursor-pointer rounded-[3px] border-0 bg-amber-400 px-2 py-1 text-[11px] font-bold text-gray-900 hover:bg-amber-500" data-entry="${entryIndex}" data-form="${formIndex}">Edit</button>
              <button class="table-btn delete-btn mx-0.5 cursor-pointer rounded-[3px] border-0 bg-red-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-red-700" data-entry="${entryIndex}" data-form="${formIndex}">Delete</button>
            </td>
          </tr>
        `;
      });
    });
    
    tableHtml += `
        </tbody>
      </table>
    `;
    
    container.innerHTML = tableHtml;
    
    // Open URLs in a new tab
    container.querySelectorAll('.url-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: link.href });
      });
    });

    // Add event listeners for action buttons
    container.querySelectorAll('.fill-btn').forEach(btn => {
      btn.addEventListener('click', () => fillForm(parseInt(btn.dataset.entry), parseInt(btn.dataset.form)));
    });
    
    container.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => viewForm(parseInt(btn.dataset.entry), parseInt(btn.dataset.form)));
    });

    container.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', () => editForm(parseInt(btn.dataset.entry), parseInt(btn.dataset.form)));
    });
    
    container.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteForm(parseInt(btn.dataset.entry), parseInt(btn.dataset.form)));
    });

    setupRowDragAndDrop(container.querySelector('tbody'), savedForms);

  } catch (error) {
    console.error('Error loading saved forms:', error);
    showStatus('Error loading saved forms: ' + error.message, 'error');
  }
}

function setupRowDragAndDrop(tbody, savedForms) {
  let draggedRow = null;

  // Only start dragging from the handle, so links, buttons and text selection keep working
  tbody.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('mousedown', () => handle.parentElement.setAttribute('draggable', 'true'));
    handle.addEventListener('mouseup', () => handle.parentElement.removeAttribute('draggable'));
  });

  tbody.addEventListener('dragstart', (e) => {
    draggedRow = e.target.closest('.form-row');
    if (!draggedRow) return;
    e.dataTransfer.effectAllowed = 'move';
    draggedRow.classList.add('opacity-40');
  });

  tbody.addEventListener('dragover', (e) => {
    if (!draggedRow) return;
    e.preventDefault();
    const targetRow = e.target.closest('.form-row');
    if (!targetRow || targetRow === draggedRow) return;

    // Insert above or below the target depending on which half the cursor is in
    const rect = targetRow.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    tbody.insertBefore(draggedRow, after ? targetRow.nextSibling : targetRow);
  });

  tbody.addEventListener('drop', (e) => e.preventDefault());

  tbody.addEventListener('dragend', async () => {
    if (!draggedRow) return;
    draggedRow.classList.remove('opacity-40');
    draggedRow.removeAttribute('draggable');
    draggedRow = null;

    const order = Array.from(tbody.querySelectorAll('.form-row'))
      .map(row => [parseInt(row.dataset.entry), parseInt(row.dataset.form)]);
    const unchanged = order.every(([entry, form], i, arr) =>
      i === 0 || entry > arr[i - 1][0] || (entry === arr[i - 1][0] && form > arr[i - 1][1]));
    if (unchanged) return;

    // Rebuild entries in the new order; consecutive rows from the same entry stay grouped
    const reordered = [];
    let previousEntry = null;
    order.forEach(([entryIndex, formIndex]) => {
      const entry = savedForms[entryIndex];
      if (entryIndex === previousEntry) {
        reordered[reordered.length - 1].forms.push(entry.forms[formIndex]);
      } else {
        reordered.push({ ...entry, forms: [entry.forms[formIndex]] });
      }
      previousEntry = entryIndex;
    });

    try {
      await chrome.storage.local.set({ savedForms: reordered });
    } catch (error) {
      console.error('Error saving order:', error);
      showStatus('Error saving order: ' + error.message, 'error');
    }
    // Re-render so row indices match storage again
    viewSavedForms();
  });
}

async function fillForm(entryIndex, formIndex) {
  try {
    const result = await chrome.storage.local.get(['savedForms']);
    const savedForms = result.savedForms || [];
    
    if (!savedForms[entryIndex] || !savedForms[entryIndex].forms[formIndex]) {
      showStatus('Form data not found', 'error');
      return;
    }
    
    const formData = savedForms[entryIndex].forms[formIndex];
    
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab || !tab.id) {
      showStatus('No active tab found', 'error');
      return;
    }
    
    // Inject and execute the fill script
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillFormOnPage,
      args: [formData]
    });
    
    if (results && results[0] && results[0].result) {
      showStatus(`Filled ${results[0].result} field(s)`, 'success');
    } else {
      showStatus('Could not fill form fields', 'error');
    }
  } catch (error) {
    console.error('Error filling form:', error);
    showStatus('Error filling form: ' + error.message, 'error');
  }
}

function fillFormOnPage(formData) {
  let filledCount = 0;
  
  formData.fields.forEach(fieldData => {
    let element = null;
    
    // Try to find element by ID first
    if (fieldData.id) {
      element = document.getElementById(fieldData.id);
    }
    
    // Try by name
    if (!element && fieldData.name) {
      element = document.querySelector(`[name="${fieldData.name}"]`);
    }
    
    // Try by XPath
    if (!element && fieldData.xpath) {
      try {
        const xpathResult = document.evaluate(
          fieldData.xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        element = xpathResult.singleNodeValue;
      } catch (e) {
        console.error('XPath error:', e);
      }
    }
    
    // Try by CSS selector
    if (!element && fieldData.selector) {
      try {
        element = document.querySelector(fieldData.selector);
      } catch (e) {
        console.error('Selector error:', e);
      }
    }
    
    if (element) {
      // Fill the element based on type
      if (fieldData.type === 'checkbox' || fieldData.type === 'radio') {
        element.checked = fieldData.checked;
      } else if (element.tagName.toLowerCase() === 'select') {
        element.value = fieldData.value;
      } else {
        element.value = fieldData.value;
      }
      
      // Trigger change event
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      
      filledCount++;
    }
  });
  
  return filledCount;
}

// Read-only summary of a saved form as label: value pairs
async function viewForm(entryIndex, formIndex) {
  try {
    const result = await chrome.storage.local.get(['savedForms']);
    const savedForms = result.savedForms || [];
    const entry = savedForms[entryIndex];
    const form = entry && entry.forms[formIndex];

    if (!form) {
      showStatus('Form data not found', 'error');
      return;
    }

    const escapeHtml = text => String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const formName = form.formName || form.formId || `Form ${form.formIndex + 1}`;

    const rows = form.fields
      .filter(field => field.type !== 'file')
      .map(field => {
        const key = escapeHtml(field.label || field.name || field.id || `${field.type} field`);
        let value;
        if (field.type === 'checkbox' || field.type === 'radio') {
          value = field.checked ? '✓ Checked' : '<span class="text-gray-400">Unchecked</span>';
        } else if (!field.value) {
          value = '<span class="text-gray-400">—</span>';
        } else if (field.type === 'password') {
          value = `<span class="password-mask cursor-pointer text-red-700" title="Click to reveal" data-value="${escapeHtml(field.value)}">••••••••</span>`;
        } else {
          value = `<span class="whitespace-pre-wrap break-words">${escapeHtml(field.value)}</span>`;
        }
        return `
          <tr>
            <td class="w-[35%] border-b border-gray-200 py-1.5 pr-3 align-top font-bold text-gray-700">${key}</td>
            <td class="border-b border-gray-200 py-1.5 align-top text-gray-900">${value}</td>
          </tr>
        `;
      })
      .join('');

    // Hide scan/export/import while viewing
    document.querySelector('.bottom-actions').classList.add('hidden');
    hideSaveSection();

    const container = document.getElementById('formDataContainer');
    container.innerHTML = `
      <div class="rounded-[4px] border border-gray-300 bg-gray-50 p-[15px]">
        <div class="mb-1 text-[15px] font-bold text-gray-800">${escapeHtml(formName)}</div>
        <div class="mb-3 break-all text-[11px] text-blue-700">${escapeHtml(entry.url)}</div>
        ${rows
          ? `<table class="w-full border-collapse text-[13px]"><tbody>${rows}</tbody></table>`
          : '<p class="text-gray-500">No fields</p>'}
        <div class="mt-4 text-left">
          <button class="view-edit-btn mr-2.5 inline-block cursor-pointer rounded-[4px] border-0 bg-amber-400 px-3 py-1.5 text-xs font-bold text-gray-900 hover:bg-amber-500">Edit</button>
          <button class="view-back-btn inline-block cursor-pointer rounded-[4px] border-0 bg-gray-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-gray-600">Back</button>
        </div>
      </div>
    `;

    container.querySelectorAll('.password-mask').forEach(mask => {
      mask.addEventListener('click', () => {
        mask.textContent = mask.dataset.value;
        mask.classList.remove('cursor-pointer');
        mask.removeAttribute('title');
      }, { once: true });
    });
    container.querySelector('.view-edit-btn').addEventListener('click', () => editForm(entryIndex, formIndex));
    container.querySelector('.view-back-btn').addEventListener('click', viewSavedForms);

  } catch (error) {
    console.error('Error viewing form:', error);
    showStatus('Error: ' + error.message, 'error');
  }
}

async function editForm(entryIndex, formIndex) {
  try {
    const result = await chrome.storage.local.get(['savedForms']);
    const savedForms = result.savedForms || [];
    
    if (!savedForms[entryIndex] || !savedForms[entryIndex].forms[formIndex]) {
      showStatus('Form data not found', 'error');
      return;
    }
    
    // Store the entry and form indices for updating later
    currentFormData = {
      url: savedForms[entryIndex].url,
      title: savedForms[entryIndex].title,
      timestamp: savedForms[entryIndex].timestamp,
      forms: [savedForms[entryIndex].forms[formIndex]],
      editMode: true,
      editEntryIndex: entryIndex,
      editFormIndex: formIndex
    };
    
    // Display the form data for editing
    displayFormData(currentFormData);
    
  } catch (error) {
    console.error('Error loading form for edit:', error);
    showStatus('Error: ' + error.message, 'error');
  }
}

async function updateFormData() {
  if (!currentFormData || !currentFormData.editMode) {
    showStatus('No form data to update', 'error');
    return;
  }
  
  try {
    // Update URL from the input field
    const urlInput = document.getElementById('pageUrl');
    if (urlInput) {
      currentFormData.url = urlInput.value;
    }
    
    // Update form name from input
    const formNameInput = document.querySelector('.form-name-input');
    if (formNameInput && currentFormData.forms[0]) {
      currentFormData.forms[0].formName = formNameInput.value;
    }
    
    // Collect edited values
    const visibleInputs = document.querySelectorAll('input[data-form], textarea[data-form]');
    const visibleFieldsSet = new Set();
    
    visibleInputs.forEach(input => {
      const formIndex = parseInt(input.dataset.form);
      const fieldIndex = parseInt(input.dataset.field);
      visibleFieldsSet.add(`${formIndex}-${fieldIndex}`);
      
      if (currentFormData.forms[formIndex] && currentFormData.forms[formIndex].fields[fieldIndex]) {
        const field = currentFormData.forms[formIndex].fields[fieldIndex];
        
        // Update selectors if it's a selector input
        if (input.dataset.selectorType) {
          if (input.dataset.selectorType === 'xpath') {
            field.xpath = input.value;
          } else if (input.dataset.selectorType === 'selector') {
            field.selector = input.value;
          }
        } else if (input.type === 'checkbox') {
          field.checked = input.checked;
        } else {
          field.value = input.value;
        }
      }
    });
    
    // Remove deleted fields
    currentFormData.forms.forEach((form, formIndex) => {
      form.fields = form.fields.filter((field, fieldIndex) => {
        return visibleFieldsSet.has(`${formIndex}-${fieldIndex}`);
      });
    });
    
    // Get existing saved forms
    const result = await chrome.storage.local.get(['savedForms']);
    const savedForms = result.savedForms || [];
    
    // Update the specific form
    if (savedForms[currentFormData.editEntryIndex]) {
      savedForms[currentFormData.editEntryIndex].url = currentFormData.url;
      savedForms[currentFormData.editEntryIndex].forms[currentFormData.editFormIndex] = currentFormData.forms[0];
    }
    
    // Save back to storage
    await chrome.storage.local.set({ savedForms: savedForms });
    
    showStatus('Form data updated successfully!', 'success');
    
    // Return to saved forms list
    setTimeout(() => {
      viewSavedForms();
    }, 500);
  } catch (error) {
    console.error('Error updating form data:', error);
    showStatus('Error updating: ' + error.message, 'error');
  }
}

async function deleteForm(entryIndex, formIndex) {
  if (!confirm('Are you sure you want to delete this form?')) {
    return;
  }
  
  try {
    const result = await chrome.storage.local.get(['savedForms']);
    const savedForms = result.savedForms || [];
    
    if (savedForms[entryIndex] && savedForms[entryIndex].forms[formIndex]) {
      savedForms[entryIndex].forms.splice(formIndex, 1);
      
      // If no forms left in this entry, remove the entire entry
      if (savedForms[entryIndex].forms.length === 0) {
        savedForms.splice(entryIndex, 1);
      }
      
      await chrome.storage.local.set({ savedForms: savedForms });
      showStatus('Form deleted successfully!', 'success');
      viewSavedForms();
    }
  } catch (error) {
    console.error('Error deleting form:', error);
    showStatus('Error deleting form: ' + error.message, 'error');
  }
}

async function exportSavedForms() {
  try {
    const result = await chrome.storage.local.get(['savedForms']);
    const savedForms = result.savedForms || [];
    
    if (savedForms.length === 0) {
      showStatus('No saved forms to export', 'error');
      return;
    }
    
    const blob = new Blob([JSON.stringify(savedForms, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `form-data-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    
    showStatus(`Exported ${savedForms.length} entr${savedForms.length !== 1 ? 'ies' : 'y'}`, 'success');
  } catch (error) {
    console.error('Error exporting forms:', error);
    showStatus('Error exporting: ' + error.message, 'error');
  }
}

async function importSavedForms(file) {
  try {
    const imported = JSON.parse(await file.text());
    
    const isValid = Array.isArray(imported) && imported.every(entry =>
      entry && typeof entry.url === 'string' && Array.isArray(entry.forms) &&
      entry.forms.every(form => form && Array.isArray(form.fields))
    );
    if (!isValid) {
      showStatus('Invalid file: not a form data export', 'error');
      return;
    }
    
    const result = await chrome.storage.local.get(['savedForms']);
    const savedForms = result.savedForms || [];
    
    // Merge, skipping entries that are already saved
    const existing = new Set(savedForms.map(entry => JSON.stringify(entry)));
    const newEntries = imported.filter(entry => !existing.has(JSON.stringify(entry)));
    savedForms.push(...newEntries);
    
    await chrome.storage.local.set({ savedForms: savedForms });
    showStatus(`Imported ${newEntries.length} entr${newEntries.length !== 1 ? 'ies' : 'y'}` +
      (newEntries.length < imported.length ? ` (${imported.length - newEntries.length} already saved)` : ''), 'success');
    viewSavedForms();
  } catch (error) {
    console.error('Error importing forms:', error);
    showStatus('Error importing: ' + error.message, 'error');
  }
}

// Re-read labels from the current tab for the form being edited, keeping
// values and any unsaved edits on screen intact
async function rescanLabels() {
  if (!currentFormData || !currentFormData.editMode) {
    return;
  }
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://')) {
      showStatus('Open the form\'s page in the current tab, then rescan', 'error');
      return;
    }
    
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: extractFormsFromPage
    });
    const scannedFields = (results?.[0]?.result || []).flatMap(form => form.fields);
    
    if (scannedFields.length === 0) {
      showStatus('No form fields found on the current tab', 'error');
      return;
    }
    
    // Match saved fields to scanned ones, most specific identifier first
    const findMatch = field =>
      (field.xpath && scannedFields.find(f => f.xpath === field.xpath)) ||
      (field.selector && scannedFields.find(f => f.selector === field.selector)) ||
      (field.id && scannedFields.find(f => f.id === field.id)) ||
      (field.name && scannedFields.find(f => f.name === field.name && f.type === field.type));
    
    let matched = 0;
    let total = 0;
    currentFormData.forms.forEach((form, formIndex) => {
      form.fields.forEach((field, fieldIndex) => {
        const heading = document.querySelector(`.field-name[data-form="${formIndex}"][data-field="${fieldIndex}"]`);
        if (!heading) return; // field deleted in the editor
        
        total++;
        const match = findMatch(field);
        if (match && match.label) {
          field.label = match.label;
          heading.innerHTML = fieldHeadingHtml(field);
          matched++;
        }
      });
    });
    
    showStatus(`Found labels for ${matched} of ${total} field${total !== 1 ? 's' : ''}. Click Update to save.`, matched ? 'success' : 'info');
  } catch (error) {
    console.error('Error rescanning labels:', error);
    showStatus('Error rescanning: ' + error.message, 'error');
  }
}
