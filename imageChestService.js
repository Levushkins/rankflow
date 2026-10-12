/**
 * imageChestService.js — Сервис интеграции с Image Chest API v1
 * 
 * Правило: ОДИН КРИТЕРИЙ = ОДИН IMAGE CHEST POST = ОДНА ССЫЛКА.
 * 
 * Endpoints:
 * - POST https://api.imgchest.com/v1/post (создание единого поста со всеми images[] критерия)
 * - POST https://api.imgchest.com/v1/post/{id}/add (добавление новых images[] к существующему посту)
 */

(function (window) {
  "use strict";

  const BASE_URL = "https://api.imgchest.com/v1";
  const MAX_IMAGES_PER_REQUEST = 20;

  const ImageChestService = {
    MAX_IMAGES_PER_REQUEST,

    /**
     * Проверка наличия токена (без блокирующего вызова к /users/me)
     * Токен считается настроенным, если он не пустой.
     * @param {string} token Bearer Personal Access Token
     * @returns {Promise<{success: boolean, username?: string|null, error?: string}>}
     */
    async verifyToken(token) {
      if (!token || !token.trim()) {
        return {
          success: false,
          error: "Токен не указан",
        };
      }

      return {
        success: true,
        username: null,
      };
    },

    /**
     * Создание единого Image Chest Post для критерия
     * Все изображения одного критерия отправляются ОДНИМ запросом в images[].
     * @param {Object} params
     * @param {string} params.token Bearer Personal Access Token
     * @param {string} params.title Название поста
     * @param {File[]} params.files Список файлов изображений (до 20 шт)
     * @returns {Promise<{success: boolean, postId?: string, postUrl?: string, imageCount?: number, images?: Array, error?: string, rawResponse?: string}>}
     */
    async createPost({ token, title, files }) {
      if (!token || !token.trim()) {
        return { success: false, error: "Не настроен Image Chest Personal Access Token. Перейдите в Настройки." };
      }

      if (!files || files.length === 0) {
        return { success: false, error: "Нет файлов для загрузки." };
      }

      if (files.length > MAX_IMAGES_PER_REQUEST) {
        return {
          success: false,
          error: `Для одного доказательства можно загрузить максимум 20 изображений в один Image Chest post (выбрано: ${files.length}).`,
        };
      }

      const url = `${BASE_URL}/post`;
      const formData = new FormData();
      formData.append("title", title || "Доказательства выполнения критерия");
      formData.append("privacy", "hidden");

      // Все изображения отправляются ОДНИМ запросом в images[]
      files.forEach((file) => {
        formData.append("images[]", file);
      });

      // Подробное отладочное логирование запроса
      console.log("Image Chest request:", {
        url: url,
        method: "POST",
        hasToken: Boolean(token),
        tokenPrefix: token ? `${token.substring(0, 4)}...` : "none",
        title: title,
        fileCount: files.length,
        files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
      });

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token.trim()}`,
            "Accept": "application/json",
            // Заголовок Content-Type НЕ передаем вручную — браузер сам установит multipart/form-data с boundary
          },
          body: formData,
        });

        // Считываем тело ответа сразу как текст для детальной диагностики
        const responseText = await response.text();

        console.log("Image Chest response:", {
          status: response.status,
          statusText: response.statusText,
          body: responseText,
        });

        // Если ответ не OK — выводим полный ответ сервера в консоль без сокрытия
        if (!response.ok) {
          console.error("Image Chest response error body (raw):", responseText);
          console.error("Image Chest failed endpoint:", url, "Status:", response.status);

          let serverMsg = "";
          try {
            const parsed = JSON.parse(responseText);
            if (parsed.message) {
              serverMsg = parsed.message;
            } else if (parsed.error) {
              serverMsg = parsed.error;
            } else if (typeof parsed === "object" && parsed !== null) {
              // Если объект с полями ошибок, например {"anonymous":["..."]}
              serverMsg = Object.entries(parsed)
                .map(([field, errs]) => `${field}: ${Array.isArray(errs) ? errs.join(", ") : errs}`)
                .join("; ");
            }
          } catch (e) {
            serverMsg = responseText;
          }

          if (!serverMsg) {
            serverMsg = responseText || response.statusText;
          }

          if (response.status === 401 || response.status === 403) {
            return {
              success: false,
              error: `Ошибка авторизации (${response.status}): Неверный токен Image Chest. Проверьте токен в Настройках. ${serverMsg ? "(" + serverMsg + ")" : ""}`,
              rawResponse: responseText,
            };
          }

          if (response.status === 404) {
            return {
              success: false,
              error: `Ошибка 404: Endpoint не найден на сервере Image Chest. Ответ сервера: ${serverMsg || "Not Found"}`,
              rawResponse: responseText,
            };
          }

          if (response.status === 429) {
            return {
              success: false,
              error: "Превышен лимит запросов Image Chest (60 запросов в минуту). Попробуйте немного позже.",
              rawResponse: responseText,
            };
          }

          return {
            success: false,
            error: `Image Chest вернул ошибку (${response.status}): ${serverMsg}`,
            rawResponse: responseText,
          };
        }

        let json;
        try {
          json = JSON.parse(responseText);
        } catch (e) {
          return {
            success: false,
            error: "Сервер Image Chest вернул некорректный JSON ответ.",
            rawResponse: responseText,
          };
        }

        const postData = json.data || json;
        const postId = postData.id;

        if (!postId) {
          return {
            success: false,
            error: "Image Chest не вернул ID созданного поста.",
            rawResponse: responseText,
          };
        }

        const postUrl = `https://imgchest.com/p/${postId}`;
        const imageCount = postData.image_count || (postData.images ? postData.images.length : files.length);

        return {
          success: true,
          postId: postId,
          postUrl: postUrl,
          imageCount: imageCount,
          images: postData.images || [],
        };
      } catch (err) {
        console.error("Image Chest network/fetch error:", err);
        return {
          success: false,
          error: `Сетевая ошибка при обращении к Image Chest (${url}): ${err.message || "Не удалось подключиться"}`,
        };
      }
    },

    /**
     * Добавление новых изображений к уже существующему посту критерия
     * @param {Object} params
     * @param {string} params.token Bearer Personal Access Token
     * @param {string} params.postId ID существующего поста Image Chest
     * @param {File[]} params.files Новые файлы (до 20 шт)
     * @returns {Promise<{success: boolean, postId?: string, postUrl?: string, imageCount?: number, images?: Array, error?: string, rawResponse?: string}>}
     */
    async addImagesToPost({ token, postId, files }) {
      if (!token || !token.trim()) {
        return { success: false, error: "Не настроен Image Chest Personal Access Token." };
      }

      if (!postId) {
        return { success: false, error: "Не указан ID существующего поста." };
      }

      if (!files || files.length === 0) {
        return { success: false, error: "Нет новых файлов для добавления." };
      }

      if (files.length > MAX_IMAGES_PER_REQUEST) {
        return {
          success: false,
          error: `В одном запросе можно передать максимум 20 изображений (выбрано: ${files.length}).`,
        };
      }

      const url = `${BASE_URL}/post/${postId}/add`;
      const formData = new FormData();
      files.forEach((file) => {
        formData.append("images[]", file);
      });

      console.log("Image Chest add images request:", {
        url: url,
        method: "POST",
        postId: postId,
        hasToken: Boolean(token),
        fileCount: files.length,
      });

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token.trim()}`,
            "Accept": "application/json",
          },
          body: formData,
        });

        const responseText = await response.text();

        console.log("Image Chest add response:", {
          status: response.status,
          statusText: response.statusText,
          body: responseText,
        });

        if (!response.ok) {
          console.error("Image Chest add error body:", responseText);

          let serverMsg = "";
          try {
            const parsed = JSON.parse(responseText);
            if (parsed.message) {
              serverMsg = parsed.message;
            } else if (parsed.error) {
              serverMsg = parsed.error;
            } else if (typeof parsed === "object" && parsed !== null) {
              serverMsg = Object.entries(parsed)
                .map(([field, errs]) => `${field}: ${Array.isArray(errs) ? errs.join(", ") : errs}`)
                .join("; ");
            }
          } catch (e) {
            serverMsg = responseText;
          }

          if (!serverMsg) {
            serverMsg = responseText || response.statusText;
          }

          if (response.status === 401 || response.status === 403) {
            return {
              success: false,
              error: `Ошибка авторизации (${response.status}): Неверный токен Image Chest.`,
              rawResponse: responseText,
            };
          }
          if (response.status === 429) {
            return {
              success: false,
              error: "Превышен лимит запросов Image Chest.",
              rawResponse: responseText,
            };
          }

          return {
            success: false,
            error: `Не удалось добавить фото к существующему посту (${response.status}): ${serverMsg}`,
            rawResponse: responseText,
          };
        }

        let json;
        try {
          json = JSON.parse(responseText);
        } catch (e) {
          return { success: false, error: "Некорректный JSON ответ при добавлении фото.", rawResponse: responseText };
        }

        const postData = json.data || json;
        const updatedCount = postData.image_count || (postData.images ? postData.images.length : undefined);

        return {
          success: true,
          postId: postId,
          postUrl: `https://imgchest.com/p/${postId}`,
          imageCount: updatedCount,
          images: postData.images || [],
        };
      } catch (err) {
        console.error("Image Chest add network error:", err);
        return {
          success: false,
          error: `Сетевая ошибка при добавлении фото в Image Chest: ${err.message || "Не удалось подключиться"}`,
        };
      }
    },
  };

  window.ImageChestService = ImageChestService;
})(window);
